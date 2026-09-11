package addondatastore

import (
	"context"
	"database/sql"
	"encoding/json"
	"github.com/pjunak/ttrpg-codex/internal/addons/datacontract"
	"time"
)

// RetainRecovery appends the fresh heads produced by campaign recovery. The
// recovery transaction keeps its original journal; reverting never erases it.
func RetainRecovery(ctx context.Context, tx *sql.Tx, actorID, operationID string) error {
	rows, err := tx.QueryContext(ctx, `WITH latest AS (
 SELECT addon_id,data_kind,data_id,document_key,MAX(revision) AS revision FROM addon_history_revisions GROUP BY addon_id,data_kind,data_id,document_key)
 SELECT h.addon_id,h.data_kind,h.data_id,h.document_key,v.revision,COALESCE(d.target_created_at,h.target_created_at),h.generation_id,v.deleted,COALESCE(d.body_json,'{}'),v.updated_at
 FROM latest AS l JOIN addon_history_revisions AS h USING(addon_id,data_kind,data_id,document_key,revision)
 JOIN addon_document_versions AS v USING(addon_id,data_kind,data_id,document_key)
 LEFT JOIN addon_documents AS d USING(addon_id,data_kind,data_id,document_key)
 WHERE v.revision>h.revision`)
	if err != nil {
		return err
	}
	type restored struct {
		addonID               string
		mutation              preparedMutation
		revision              int64
		generation, timestamp string
	}
	var changes []restored
	for rows.Next() {
		var r restored
		var kind datacontract.Kind
		var dataID, key, target, body string
		var deleted bool
		if err = rows.Scan(&r.addonID, &kind, &dataID, &key, &r.revision, &target, &r.generation, &deleted, &body, &r.timestamp); err != nil {
			rows.Close()
			return err
		}
		created, err := time.Parse(time.RFC3339Nano, target)
		if err != nil {
			rows.Close()
			return ErrStorageInvariant
		}
		r.mutation = preparedMutation{Mutation: Mutation{Kind: Put, Definition: datacontract.Description{Kind: kind, ID: dataID, Retained: true}, Key: key, TargetCreatedAt: &created}, value: json.RawMessage(body)}
		if deleted {
			r.mutation.Kind = Delete
		}
		changes = append(changes, r)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, r := range changes {
		input := Transaction{AddonID: r.addonID, GenerationID: r.generation, ActorID: actorID, OperationID: operationID, Operation: "campaign.restore", Summary: "Restored campaign recovery point"}
		if err = retainRevision(ctx, tx, input, r.mutation, r.revision, r.timestamp); err != nil {
			return err
		}
	}
	return nil
}
