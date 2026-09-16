// Package campaignimport retains host-owned, reviewed campaign bundle plans.
package campaignimport

import (
	"bytes"
	"crypto/rand"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/pjunak/ttrpg-codex/internal/application/campaigndata"
	"github.com/pjunak/ttrpg-codex/internal/domain/campaign"
	"github.com/santhosh-tekuri/jsonschema/v6"
)

const Format = "ttrpg-codex-campaign-bundle"
const ContributorContract = "codex.campaign-bundle-contributor"

//go:embed campaign-bundle.schema.json
var documentSchema []byte

type operation struct {
	Ref       string         `json:"ref"`
	Operation string         `json:"operation"`
	Record    map[string]any `json:"record"`
}
type contribution struct {
	AddonID       string         `json:"addonId"`
	ContributorID string         `json:"contributorId"`
	Document      map[string]any `json:"document"`
}
type document struct {
	Format        string                              `json:"format"`
	SchemaVersion int                                 `json:"schemaVersion"`
	GeneratedAt   int64                               `json:"generatedAt"`
	Records       map[campaign.Collection][]operation `json:"records"`
	AddonImports  []contribution                      `json:"addonImports"`
}
type Reference struct {
	Ref        string              `json:"ref"`
	Collection campaign.Collection `json:"collection"`
	ID         string              `json:"id"`
}

func compileSchema() (*jsonschema.Schema, error) {
	compiler := jsonschema.NewCompiler()
	value, err := jsonschema.UnmarshalJSON(bytes.NewReader(documentSchema))
	if err != nil {
		return nil, err
	}
	if err = compiler.AddResource("https://ttrpg-codex.local/schemas/import/campaign-bundle-v1.schema.json", value); err != nil {
		return nil, err
	}
	return compiler.Compile("https://ttrpg-codex.local/schemas/import/campaign-bundle-v1.schema.json")
}
func randomID() (string, error) {
	value := make([]byte, 24)
	_, err := rand.Read(value)
	return hex.EncodeToString(value), err
}

func (service *Service) prepareDocument(body json.RawMessage, snapshot campaign.Snapshot) ([]campaign.Mutation, []Reference, []contribution, error) {
	if len(body) > 2<<20 {
		return nil, nil, nil, errors.New("bundle exceeds 2 MiB")
	}
	value, err := jsonschema.UnmarshalJSON(bytes.NewReader(body))
	if err != nil {
		return nil, nil, nil, err
	}
	if err = service.schema.Validate(value); err != nil {
		return nil, nil, nil, err
	}
	var input document
	if err = json.Unmarshal(body, &input); err != nil {
		return nil, nil, nil, err
	}
	count := 0
	refs := map[string]Reference{}
	mappings := []Reference{}
	for _, collection := range []campaign.Collection{campaign.Characters, campaign.Locations, campaign.Relationships} {
		for _, entry := range input.Records[collection] {
			count++
			if count > 128 {
				return nil, nil, nil, errors.New("bundle exceeds 128 core records")
			}
			if _, ok := refs[entry.Ref]; ok {
				return nil, nil, nil, errors.New("duplicate local reference")
			}
			id, err := randomID()
			if err != nil {
				return nil, nil, nil, err
			}
			refs[entry.Ref] = Reference{entry.Ref, collection, id}
		}
	}
	existing := map[string]bool{}
	for _, record := range snapshot.Records {
		existing[string(record.Collection)+"/"+record.Key] = true
	}
	resolve := func(raw any, expected campaign.Collection) (string, error) {
		reference, ok := raw.(map[string]any)
		if !ok {
			return "", errors.New("typed reference required")
		}
		if local, ok := reference["$ref"].(string); ok {
			found, ok := refs[local]
			if !ok || found.Collection != expected {
				return "", fmt.Errorf("invalid %s reference %q", expected, local)
			}
			return found.ID, nil
		}
		target, ok := reference["$id"].(map[string]any)
		if !ok || target["collection"] != string(expected) {
			return "", errors.New("existing reference has wrong collection")
		}
		id, _ := target["id"].(string)
		if !existing[string(expected)+"/"+id] {
			return "", errors.New("existing reference is missing")
		}
		return id, nil
	}
	targets, err := campaigndata.ImportRelationshipTargets(snapshot)
	if err != nil {
		return nil, nil, nil, err
	}
	mutations := []campaign.Mutation{}
	keys := map[string]bool{}
	for _, collection := range []campaign.Collection{campaign.Characters, campaign.Locations, campaign.Relationships} {
		for _, entry := range input.Records[collection] {
			fields := entry.Record
			set := func(field string, expected campaign.Collection) error {
				if value, ok := fields[field]; ok {
					id, err := resolve(value, expected)
					if err != nil {
						return err
					}
					fields[field] = id
				}
				return nil
			}
			switch collection {
			case campaign.Characters:
				fields["id"] = refs[entry.Ref].ID
				if err = set("location", campaign.Locations); err != nil {
					return nil, nil, nil, err
				}
				if roles, ok := fields["locationRoles"].([]any); ok {
					for _, role := range roles {
						item := role.(map[string]any)
						id, err := resolve(item["locationId"], campaign.Locations)
						if err != nil {
							return nil, nil, nil, err
						}
						item["locationId"] = id
					}
				}
			case campaign.Locations:
				fields["id"] = refs[entry.Ref].ID
				if err = set("parentId", campaign.Locations); err != nil {
					return nil, nil, nil, err
				}
				if connections, ok := fields["connections"].([]any); ok {
					for i, item := range connections {
						id, err := resolve(item, campaign.Locations)
						if err != nil {
							return nil, nil, nil, err
						}
						connections[i] = id
					}
				}
			case campaign.Relationships:
				kind := campaign.Characters
				if target, ok := targets[fields["type"].(string)]; ok {
					kind = target
				}
				if err = set("source", campaign.Characters); err != nil {
					return nil, nil, nil, err
				}
				if err = set("target", kind); err != nil {
					return nil, nil, nil, err
				}
			}
			body, err := json.Marshal(fields)
			if err != nil {
				return nil, nil, nil, err
			}
			key, err := campaign.ListRecordKey(collection, body)
			if err != nil {
				return nil, nil, nil, err
			}
			identity := string(collection) + "/" + key
			if existing[identity] || keys[identity] {
				return nil, nil, nil, errors.New("create would replace an existing or duplicate record")
			}
			keys[identity] = true
			ref := refs[entry.Ref]
			ref.ID = key
			refs[entry.Ref] = ref
			mappings = append(mappings, ref)
			mutations = append(mutations, campaign.Mutation{Kind: campaign.Put, Collection: collection, Key: key, Value: body})
		}
	}
	seen := map[string]bool{}
	for i, entry := range input.AddonImports {
		if seen[entry.AddonID] {
			return nil, nil, nil, errors.New("only one contribution per add-on is allowed")
		}
		seen[entry.AddonID] = true
		resolved, err := resolveContribution(entry.Document, refs)
		if err != nil {
			return nil, nil, nil, err
		}
		input.AddonImports[i].Document = resolved.(map[string]any)
	}
	return mutations, mappings, input.AddonImports, nil
}

func resolveContribution(value any, refs map[string]Reference) (any, error) {
	switch item := value.(type) {
	case map[string]any:
		if local, present := item["$ref"]; present {
			name, ok := local.(string)
			ref, found := refs[name]
			if !ok || !found || len(item) != 1 {
				return nil, errors.New("invalid contribution reference")
			}
			return ref.ID, nil
		}
		for key, child := range item {
			resolved, err := resolveContribution(child, refs)
			if err != nil {
				return nil, err
			}
			item[key] = resolved
		}
	case []any:
		for index, child := range item {
			resolved, err := resolveContribution(child, refs)
			if err != nil {
				return nil, err
			}
			item[index] = resolved
		}
	}
	return value, nil
}
