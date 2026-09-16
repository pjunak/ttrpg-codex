package campaignimport

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/addons/datacontract"
	"github.com/pjunak/ttrpg-codex/internal/application/campaigndata"
	"github.com/pjunak/ttrpg-codex/internal/domain/campaign"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/addondatastore"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/unitofwork"
	"github.com/pjunak/ttrpg-codex/sdk/go/workerrpc"
	"github.com/santhosh-tekuri/jsonschema/v6"
)

type Owner struct{ ActorID, AddonID, Generation string }
type Contributor interface {
	PrepareCampaignContribution(context.Context, workerrpc.Actor, string, string, json.RawMessage) (addondatastore.Transaction, error)
}
type Service struct {
	db           *sql.DB
	core         campaigndata.Repository
	addons       *addondatastore.Store
	contributors Contributor
	schema       *jsonschema.Schema
	now          func() time.Time
	mu           sync.Mutex
	plans        map[string]plan
}
type plan struct {
	bytes   int
	owner   Owner
	expires time.Time
	states  []campaign.CollectionState
	core    campaign.Transaction
	addons  []addondatastore.Transaction
	receipt Receipt
}
type Receipt struct {
	ContractVersion string `json:"contractVersion"`
	Committed       bool   `json:"committed"`
	Writes          int    `json:"writes"`
	Deletes         int    `json:"deletes"`
}
type Change struct {
	Collection string          `json:"collection"`
	ID         string          `json:"id"`
	Operation  string          `json:"operation"`
	Label      string          `json:"label"`
	DM         json.RawMessage `json:"dm,omitempty"`
	Player     json.RawMessage `json:"player,omitempty"`
}
type Summary struct {
	Creates int `json:"creates"`
	Updates int `json:"updates"`
	Skips   int `json:"skips"`
	Deletes int `json:"deletes"`
}
type Preview struct {
	ContractVersion string      `json:"contractVersion"`
	Token           string      `json:"token"`
	Format          string      `json:"format"`
	Mode            string      `json:"mode"`
	Summary         Summary     `json:"summary"`
	Warnings        []string    `json:"warnings"`
	Changes         []Change    `json:"changes"`
	References      []Reference `json:"references"`
	ExpiresAt       string      `json:"expiresAt"`
}

func New(ctx context.Context, db *sql.DB, core campaigndata.Repository, addons *addondatastore.Store, contributors Contributor) (*Service, error) {
	if db == nil || core == nil || addons == nil {
		return nil, errors.New("campaign import stores are required")
	}
	schema, err := compileSchema()
	if err != nil {
		return nil, err
	}
	// A process interruption never retries a consumed plan.
	if _, err = db.ExecContext(ctx, "UPDATE campaign_import_receipts SET status='failed' WHERE status='committing'"); err != nil {
		return nil, err
	}
	return &Service{db: db, core: core, addons: addons, contributors: contributors, schema: schema, now: time.Now, plans: map[string]plan{}}, nil
}
func problem(kind, message string) error {
	return workerrpc.NewRPCError(workerrpc.JSONRPCApplication, kind, message, false, nil)
}
func (service *Service) Preview(ctx context.Context, owner Owner, body json.RawMessage) (Preview, error) {
	snapshot, err := service.core.Snapshot(ctx, true)
	if err != nil {
		return Preview{}, err
	}
	requested, refs, contributions, err := service.prepareDocument(body, snapshot)
	if err != nil {
		return Preview{}, problem(workerrpc.KindValidationFailed, "The bundle has invalid records or references.")
	}
	at := service.now().UTC()
	transaction := campaign.Transaction{ActorID: owner.ActorID}
	candidate := snapshot
	if len(requested) > 0 {
		transaction, candidate, err = campaigndata.PlanImport(snapshot, owner.ActorID, requested, at)
		if err != nil {
			return Preview{}, problem(workerrpc.KindValidationFailed, "The bundle violates campaign invariants.")
		}
	}
	dm, public, err := campaigndata.ImportViews(candidate)
	if err != nil {
		return Preview{}, err
	}
	views := func(dataset campaigndata.Dataset) map[string]json.RawMessage {
		result := map[string]json.RawMessage{}
		for _, collection := range dataset.Collections {
			for _, record := range collection.Records {
				result[string(collection.Name)+"/"+record.Key] = record.Value
			}
		}
		return result
	}
	dmViews, playerViews := views(dm), views(public)
	preview := Preview{ContractVersion: "import-preview-result.v1", Format: Format, Mode: "merge", Warnings: []string{}, Changes: []Change{}, References: refs, ExpiresAt: at.Add(15 * time.Minute).Format(time.RFC3339)}
	retained := plan{owner: owner, expires: at.Add(15 * time.Minute), states: snapshot.States, core: transaction, receipt: Receipt{ContractVersion: "import-commit-result.v1", Committed: true}}
	for _, mutation := range transaction.Mutations {
		operation := "create"
		if mutation.ExpectedRevision > 0 {
			operation = "update"
		}
		change := Change{Collection: string(mutation.Collection), ID: mutation.Key, Operation: operation, Label: recordLabel(mutation.Value, mutation.Key), DM: dmViews[string(mutation.Collection)+"/"+mutation.Key], Player: playerViews[string(mutation.Collection)+"/"+mutation.Key]}
		if mutation.Kind == campaign.Delete {
			change.Operation = "delete"
		}
		preview.Changes = append(preview.Changes, change)
	}
	for _, entry := range contributions {
		if service.contributors == nil {
			return Preview{}, problem(workerrpc.KindUnavailable, "A requested bundle contributor is unavailable.")
		}
		body, _ := json.Marshal(entry.Document)
		contribution, err := service.contributors.PrepareCampaignContribution(ctx, workerrpc.Actor{Role: "dm", ID: owner.ActorID}, entry.AddonID, entry.ContributorID, body)
		if err != nil {
			return Preview{}, err
		}
		// The host-selected definition and namespace are never supplied by the bundle.
		if contribution.AddonID != entry.AddonID {
			return Preview{}, errors.New("contributor namespace mismatch")
		}
		contribution.ActorID = owner.ActorID
		retained.addons = append(retained.addons, contribution)
		for _, mutation := range contribution.Mutations {
			operation := "create"
			if mutation.ExpectedRevision > 0 {
				operation = "update"
			}
			if mutation.Kind == addondatastore.Delete {
				operation = "delete"
			}
			change := Change{Collection: entry.AddonID + "/" + mutation.Definition.ID, ID: mutation.Key, Operation: operation, Label: recordLabel(mutation.Value, mutation.Key), DM: mutation.Value}
			if mutation.Definition.Visibility == datacontract.VisibilityPublic {
				change.Player = mutation.Value
			}
			preview.Changes = append(preview.Changes, change)
		}
	}
	if len(preview.Changes) == 0 || len(preview.Changes) > 256 {
		return Preview{}, problem(workerrpc.KindValidationFailed, "A bundle must produce between 1 and 256 writes.")
	}
	for _, change := range preview.Changes {
		switch change.Operation {
		case "create":
			preview.Summary.Creates++
		case "update":
			preview.Summary.Updates++
		case "delete":
			preview.Summary.Deletes++
		}
	}
	retained.receipt.Writes = preview.Summary.Creates + preview.Summary.Updates
	retained.receipt.Deletes = preview.Summary.Deletes
	token, err := randomID()
	if err != nil {
		return Preview{}, err
	}
	preview.Token = token
	encoded, _ := json.Marshal(preview)
	if len(encoded) > 8<<20 {
		return Preview{}, problem(workerrpc.KindValidationFailed, "The review exceeds the 8 MiB limit.")
	}
	if err = ctx.Err(); err != nil {
		return Preview{}, err
	}
	service.mu.Lock()
	defer service.mu.Unlock()
	for token, plan := range service.plans {
		if !at.Before(plan.expires) {
			delete(service.plans, token)
		}
	}
	retained.bytes = len(encoded)
	totalBytes := retained.bytes
	for _, pending := range service.plans {
		totalBytes += pending.bytes
	}
	if len(service.plans) >= 128 || totalBytes > 32<<20 {
		return Preview{}, problem(workerrpc.KindRateLimited, "Too many retained previews. Cancel an unused preview.")
	}
	service.plans[token] = retained
	return preview, nil
}
func recordLabel(body json.RawMessage, key string) string {
	var fields map[string]any
	_ = json.Unmarshal(body, &fields)
	for _, field := range []string{"name", "title", "label"} {
		if value, ok := fields[field].(string); ok && value != "" {
			runes := []rune(value)
			return string(runes[:min(len(runes), 200)])
		}
	}
	runes := []rune(key)
	return string(runes[:min(len(runes), 200)])
}
func tokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
func (service *Service) take(owner Owner, token string) (plan, error) {
	service.mu.Lock()
	defer service.mu.Unlock()
	retained, ok := service.plans[token]
	if !ok || retained.owner != owner {
		return plan{}, problem(workerrpc.KindNotFound, "The preview is missing or belongs to another session.")
	}
	delete(service.plans, token)
	if !service.now().Before(retained.expires) {
		return plan{}, problem(workerrpc.KindNotFound, "The preview expired.")
	}
	return retained, nil
}
func (service *Service) Cancel(owner Owner, token string) error {
	_, err := service.take(owner, token)
	return err
}
func (service *Service) Commit(ctx context.Context, owner Owner, token string) (Receipt, error) {
	retained, err := service.take(owner, token)
	if err != nil {
		return Receipt{}, err
	}
	hash := tokenHash(token)
	if _, err = service.db.ExecContext(ctx, "INSERT INTO campaign_import_receipts(token_hash,status,created_at,result_json) VALUES(?,'committing',?,'{}')", hash, service.now().UTC().Format(time.RFC3339Nano)); err != nil {
		return Receipt{}, err
	}
	err = unitofwork.Run(ctx, service.db, func(ctx context.Context, tx *sql.Tx) error {
		if err := guardGeneration(ctx, tx, owner.AddonID, owner.Generation); err != nil {
			return err
		}
		for _, state := range retained.states {
			var revision int64
			if err := tx.QueryRowContext(ctx, "SELECT revision FROM campaign_collections WHERE name=?", state.Collection).Scan(&revision); err != nil {
				return err
			}
			if revision != state.Revision {
				return campaign.ErrConflict
			}
		}
		for _, contribution := range retained.addons {
			for _, guard := range contribution.ExpectedDataSets {
				var revision int64
				err := tx.QueryRowContext(ctx, `SELECT revision FROM addon_data_sets WHERE addon_id=? AND data_kind=? AND data_id=?`, contribution.AddonID, guard.Kind, guard.DataID).Scan(&revision)
				if err != nil && !errors.Is(err, sql.ErrNoRows) {
					return err
				}
				if revision != guard.Revision {
					return addondatastore.ErrConflict
				}
			}
			if err := guardGeneration(ctx, tx, contribution.AddonID, contribution.GenerationID); err != nil {
				return err
			}
		}
		if len(retained.core.Mutations) > 0 {
			if _, err := service.core.Transact(ctx, retained.core); err != nil {
				return err
			}
		}
		for _, contribution := range retained.addons {
			if len(contribution.Mutations) > 0 {
				if _, err := service.addons.Transact(ctx, contribution); err != nil {
					return err
				}
			}
		}
		body, _ := json.Marshal(retained.receipt)
		_, err := tx.ExecContext(ctx, "UPDATE campaign_import_receipts SET status='committed',result_json=? WHERE token_hash=?", string(body), hash)
		return err
	})
	if err != nil {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
		defer cancel()
		_, _ = service.db.ExecContext(cleanup, "UPDATE campaign_import_receipts SET status='failed' WHERE token_hash=? AND status='committing'", hash)
		if errors.Is(err, campaign.ErrConflict) || errors.Is(err, addondatastore.ErrConflict) {
			return Receipt{}, problem(workerrpc.KindConflict, "The data or generation changed. Review a new preview.")
		}
		return Receipt{}, err
	}
	return retained.receipt, nil
}
func guardGeneration(ctx context.Context, tx *sql.Tx, addonID, generation string) error {
	var active bool
	if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM addon_package_states WHERE addon_id=? AND active_generation_id=?)", addonID, generation).Scan(&active); err != nil {
		return err
	}
	if !active {
		return campaign.ErrConflict
	}
	return nil
}
func (service *Service) Status(ctx context.Context, token string) (map[string]any, error) {
	var status, body string
	err := service.db.QueryRowContext(ctx, "SELECT status,result_json FROM campaign_import_receipts WHERE token_hash=?", tokenHash(token)).Scan(&status, &body)
	if errors.Is(err, sql.ErrNoRows) {
		status = "missing"
		body = "{}"
	} else if err != nil {
		return nil, err
	}
	return map[string]any{"contractVersion": "import-status.v1", "status": status, "result": json.RawMessage(body)}, nil
}
