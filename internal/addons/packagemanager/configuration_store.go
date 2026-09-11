package packagemanager

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"

	"github.com/pjunak/ttrpg-codex/internal/addons/packageinspect"
)

var ErrConfigurationConflict = errors.New("add-on configuration changed; review the current choices")
var ErrRulesetCompatibility = errors.New("source does not support the instance ruleset")

type InstanceRuleset struct {
	packageinspect.RulesetDefinition
	AddonID string `json:"addonId"`
}

type instanceConfiguration struct {
	Revision int64
	Ruleset  *InstanceRuleset
	Sources  map[string]map[string]map[string]bool
}

type configurationReader interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func readConfiguration(ctx context.Context, reader configurationReader) (instanceConfiguration, error) {
	var result instanceConfiguration
	var rules, sources []byte
	if err := reader.QueryRowContext(ctx, `SELECT revision, ruleset_json, sources_json FROM addon_instance_configuration WHERE id = 1`).Scan(&result.Revision, &rules, &sources); err != nil {
		return result, err
	}
	if err := json.Unmarshal(rules, &result.Ruleset); err != nil {
		return result, err
	}
	if err := json.Unmarshal(sources, &result.Sources); err != nil {
		return result, err
	}
	if result.Sources == nil {
		result.Sources = make(map[string]map[string]map[string]bool)
	}
	return result, nil
}

func (store *store) configuration(ctx context.Context) (instanceConfiguration, error) {
	return readConfiguration(ctx, store.db)
}

func (store *store) saveSources(ctx context.Context, configuration instanceConfiguration) error {
	body, err := json.Marshal(configuration.Sources)
	if err != nil {
		return err
	}
	result, err := store.db.ExecContext(ctx, `UPDATE addon_instance_configuration SET sources_json = ?, revision = revision + 1 WHERE id = 1 AND revision = ?`, string(body), configuration.Revision)
	if err != nil {
		return err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if changed != 1 {
		return ErrConfigurationConflict
	}
	return nil
}

// Ruleset establishment shares the activation transaction. Disabling a package
// never resets it: saved choices still belong to the same instance ruleset.
func establishRuleset(ctx context.Context, tx *sql.Tx, manifest packageinspect.Manifest) error {
	if manifest.Rules == nil || manifest.Rules.Defines == nil {
		return nil
	}
	configuration, err := readConfiguration(ctx, tx)
	if err != nil {
		return err
	}
	if configuration.Ruleset != nil {
		if configuration.Ruleset.ID != manifest.Rules.Defines.ID || configuration.Ruleset.Contract != manifest.Rules.Defines.Contract {
			return ErrRulesetCompatibility
		}
		if configuration.Ruleset.AddonID != manifest.ID {
			var generation sql.NullString
			if err := tx.QueryRowContext(ctx, `SELECT active_generation_id FROM addon_package_states WHERE addon_id = ?`, configuration.Ruleset.AddonID).Scan(&generation); err != nil {
				return err
			}
			if generation.Valid && generation.String != "" {
				return ErrRulesetCompatibility
			}
		}
	}
	rules := InstanceRuleset{RulesetDefinition: *manifest.Rules.Defines, AddonID: manifest.ID}
	body, err := json.Marshal(rules)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `UPDATE addon_instance_configuration SET ruleset_json = ?, revision = revision + 1 WHERE id = 1`, string(body))
	return err
}
