package packagemanager

import (
	"context"
	"encoding/json"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/addons/datacontract"
	"github.com/pjunak/ttrpg-codex/internal/addons/servicebroker"
	"github.com/pjunak/ttrpg-codex/internal/application/campaignimport"
	"github.com/pjunak/ttrpg-codex/internal/events"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/addondatastore"
	"github.com/pjunak/ttrpg-codex/sdk/go/workerrpc"
)

// AuthorizeCampaignImportConsumer grants the built-in adapter only to an active
// browser consumer of its compatible, nonexclusive import contract.
func (manager *Manager) AuthorizeCampaignImportConsumer(ctx context.Context, addonID, generation string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	active, ok := manager.browserServiceRuntime(addonID, generation)
	if !ok {
		return ErrNotActive
	}
	declaration, ok := consumedService(active.report.Manifest, "codex.import-adapter")
	if !ok || declaration.Cardinality != "many" || !versionSatisfies("3.0.0", declaration.Range) {
		return ErrServiceResolution
	}
	return nil
}

func (manager *Manager) PrepareCampaignContribution(ctx context.Context, actor workerrpc.Actor, addonID, contributorID string, document json.RawMessage) (addondatastore.Transaction, error) {
	manager.mu.Lock()
	active, ok := manager.runtimes[addonID]
	if !ok {
		manager.mu.Unlock()
		return addondatastore.Transaction{}, ErrNotActive
	}
	generation := active.generation.GenerationID
	registry := active.report.DataRegistry()
	manager.mu.Unlock()
	handle, err := manager.broker.ConnectOwnBrowserService(ctx, addonID, generation, campaignimport.ContributorContract, "^1.0.0")
	if err != nil {
		return addondatastore.Transaction{}, err
	}
	params, _ := json.Marshal(map[string]any{"contractVersion": "campaign-contribution.v1", "contributorId": contributorID, "document": document})
	response, err := manager.broker.Call(ctx, handle, servicebroker.MethodCall{Method: "preview", Params: json.RawMessage(params), Context: servicebroker.CallContext{Actor: actor, Deadline: time.Now().Add(15 * time.Second), ReadOnly: true}})
	if err != nil {
		return addondatastore.Transaction{}, err
	}
	var result struct {
		ContractVersion  string                           `json:"contractVersion"`
		ExpectedDataSets []addondatastore.DataSetRevision `json:"expectedDataSets"`
		Mutations        []struct {
			Operation        string          `json:"operation"`
			Collection       string          `json:"collection"`
			Key              string          `json:"key"`
			ExpectedRevision int64           `json:"expectedRevision"`
			Value            json.RawMessage `json:"value,omitempty"`
		} `json:"mutations"`
	}
	if err = json.Unmarshal(response, &result); err != nil || result.ContractVersion != "campaign-contribution-plan.v1" || len(result.Mutations) > 256 || len(response) > 2<<20 {
		return addondatastore.Transaction{}, servicebroker.ErrInvalidCall
	}
	guards := map[string]bool{}
	for _, guard := range result.ExpectedDataSets {
		if guard.Kind != datacontract.Collection || guard.Revision < 0 || guards[guard.DataID] {
			return addondatastore.Transaction{}, servicebroker.ErrInvalidCall
		}
		if _, err = registry.Description(guard.Kind, guard.DataID); err != nil {
			return addondatastore.Transaction{}, err
		}
		guards[guard.DataID] = true
	}
	transaction := addondatastore.Transaction{AddonID: addonID, GenerationID: generation, ActorID: actor.ID, ExpectedDataSets: result.ExpectedDataSets, Mutations: []addondatastore.Mutation{}}
	seen := map[string]bool{}
	for _, mutation := range result.Mutations {
		definition, err := registry.Description(datacontract.Collection, mutation.Collection)
		key := mutation.Collection + "/" + mutation.Key
		if err != nil || !guards[mutation.Collection] || seen[key] || mutation.ExpectedRevision < 0 {
			return addondatastore.Transaction{}, servicebroker.ErrInvalidCall
		}
		seen[key] = true
		kind := addondatastore.OperationKind(mutation.Operation)
		if kind != addondatastore.Put && kind != addondatastore.Delete {
			return addondatastore.Transaction{}, servicebroker.ErrInvalidCall
		}
		if kind == addondatastore.Put {
			if err = registry.Validate(datacontract.Collection, mutation.Collection, mutation.Value); err != nil {
				return addondatastore.Transaction{}, err
			}
		}
		audience := events.AudienceDM
		if definition.Visibility == datacontract.VisibilityPublic {
			audience = events.AudiencePublic
		}
		transaction.Mutations = append(transaction.Mutations, addondatastore.Mutation{Kind: kind, Definition: definition, Key: mutation.Key, ExpectedRevision: mutation.ExpectedRevision, Value: mutation.Value, Audience: audience})
	}
	return transaction, nil
}
