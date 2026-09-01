package legacyconvert

import (
	"archive/zip"
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"sort"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/addons/datacontract"
	"github.com/pjunak/ttrpg-codex/internal/addons/packageinspect"
	"github.com/pjunak/ttrpg-codex/internal/domain/campaign"
	"github.com/pjunak/ttrpg-codex/internal/events"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/addondatastore"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/campaignstore"
)

const addonMigrationActor = "migration:v1-addon-data"

var dmToolsCollections = []string{
	"planning_items",
	"planning_flow_links",
	"planning_references",
	"planning_consequences",
	"dm_notes",
	"planning_views",
}

type targetPackage struct {
	filename string
	report   packageinspect.Report
}

func inspectTargetPackages(ctx context.Context, filenames []string) (map[string]targetPackage, error) {
	inspector, err := packageinspect.New(packageinspect.DefaultLimits)
	if err != nil {
		return nil, fmt.Errorf("create target package inspector: %w", err)
	}
	result := make(map[string]targetPackage, len(filenames))
	for _, filename := range filenames {
		absolute, err := filepath.Abs(filename)
		if err != nil {
			return nil, fmt.Errorf("resolve target add-on package: %w", err)
		}
		report, err := inspector.InspectFile(ctx, absolute)
		if err != nil {
			return nil, fmt.Errorf("inspect target add-on package %q: %w", filename, err)
		}
		if report.Manifest.ID != "dm-tools" && report.Manifest.ID != "dnd-sheets" {
			return nil, fmt.Errorf("unsupported conversion target package %q", report.Manifest.ID)
		}
		if _, duplicate := result[report.Manifest.ID]; duplicate {
			return nil, fmt.Errorf("duplicate target add-on package %q", report.Manifest.ID)
		}
		if err := validateTargetPackage(report); err != nil {
			return nil, err
		}
		result[report.Manifest.ID] = targetPackage{filename: absolute, report: report}
	}
	return result, nil
}

func validateTargetPackage(report packageinspect.Report) error {
	require := func(kind datacontract.Kind, id, target string, keyed bool, visibility datacontract.Visibility) error {
		description, err := report.DataRegistry().Description(kind, id)
		if err != nil || description.SchemaVersion != "3.0.0" || description.Target != target ||
			description.Keyed != keyed || description.Visibility != visibility {
			return fmt.Errorf("target package %q does not declare the required v3 %s %q", report.Manifest.ID, kind, id)
		}
		return nil
	}
	switch report.Manifest.ID {
	case "dm-tools":
		for _, collection := range dmToolsCollections {
			if err := require(datacontract.Collection, collection, "", true, datacontract.VisibilityDM); err != nil {
				return err
			}
		}
	case "dnd-sheets":
		return require(datacontract.RecordExtension, "dnd-sheets", "characters", false, datacontract.VisibilityPublic)
	default:
		return fmt.Errorf("unsupported conversion target package %q", report.Manifest.ID)
	}
	return nil
}

func verifyTargetPackages(ctx context.Context, packages map[string]targetPackage) error {
	if len(packages) == 0 {
		return nil
	}
	inspector, err := packageinspect.New(packageinspect.DefaultLimits)
	if err != nil {
		return err
	}
	for id, target := range packages {
		report, err := inspector.InspectFile(ctx, target.filename)
		if err != nil || report.Manifest.ID != id || report.Manifest.Version != target.report.Manifest.Version ||
			report.ArchiveSHA256 != target.report.ArchiveSHA256 {
			return fmt.Errorf("target add-on package %q changed during conversion", id)
		}
	}
	return nil
}

func importLegacyAddons(
	ctx context.Context,
	database *sql.DB,
	backup *legacyBackup,
	packages map[string]targetPackage,
	convertedAt time.Time,
) (AddonReport, error) {
	report := AddonReport{
		TargetPackages:   make(map[string]TargetPackageReport, len(packages)),
		Documents:        make(map[string]int),
		DeferredEmbedded: make(map[string]int),
	}
	for id, target := range packages {
		report.TargetPackages[id] = TargetPackageReport{
			Version: target.report.Manifest.Version, ArchiveSHA256: target.report.ArchiveSHA256,
		}
	}
	journal, err := events.New(events.Config{DB: database, Now: func() time.Time { return convertedAt }})
	if err != nil {
		return AddonReport{}, fmt.Errorf("create conversion event journal: %w", err)
	}
	addonStore, err := addondatastore.New(addondatastore.Config{
		DB: database, Events: journal, Now: func() time.Time { return convertedAt },
	})
	if err != nil {
		return AddonReport{}, fmt.Errorf("create conversion add-on store: %w", err)
	}
	coreStore, err := campaignstore.New(campaignstore.Config{
		DB: database, Events: journal, Now: func() time.Time { return convertedAt },
	})
	if err != nil {
		return AddonReport{}, fmt.Errorf("create conversion campaign store: %w", err)
	}
	if err := importDMTools(ctx, database, addonStore, backup, packages, convertedAt, &report); err != nil {
		return AddonReport{}, err
	}
	if err := importCharacterSheets(ctx, addonStore, coreStore, backup.dataset, packages, &report); err != nil {
		return AddonReport{}, err
	}
	return report, nil
}

func importDMTools(
	ctx context.Context,
	database *sql.DB,
	store *addondatastore.Store,
	backup *legacyBackup,
	packages map[string]targetPackage,
	convertedAt time.Time,
	report *AddonReport,
) error {
	sourceFiles := make(map[string]*zip.File)
	recordsByCollection := make(map[string]map[string]json.RawMessage)
	for _, collection := range dmToolsCollections {
		filename := "data/addon-data/dm-tools/" + collection + ".json"
		file := backup.files[filename]
		if file == nil {
			continue
		}
		body, err := readZipFile(file, campaign.MaximumLegacyDatasetBytes)
		if err != nil {
			return err
		}
		var records map[string]json.RawMessage
		if err := decodeJSONObject(body, &records); err != nil {
			return fmt.Errorf("%w: %s must contain one keyed object: %v", ErrInvalidLegacyBackup, filename, err)
		}
		sourceFiles[collection] = file
		recordsByCollection[collection] = records
	}
	if len(sourceFiles) == 0 {
		return nil
	}
	target, exists := packages["dm-tools"]
	if !exists {
		return fmt.Errorf("v1 backup contains DM Tools data; provide its v3 ZIP with -addon-package")
	}
	for collection, records := range recordsByCollection {
		filename := sourceFiles[collection].Name
		keys := make([]string, 0, len(records))
		for key := range records {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			value := records[key]
			if !recordIDMatches(value, key) {
				return fmt.Errorf("%w: %s record %q has a different embedded id", ErrInvalidLegacyBackup, filename, key)
			}
			if err := target.report.DataRegistry().Validate(datacontract.Collection, collection, value); err != nil {
				return fmt.Errorf("%w: %s record %q does not match the target package: %v", ErrInvalidLegacyBackup, filename, key, err)
			}
		}
	}
	if err := validateDMPlanning(recordsByCollection); err != nil {
		return fmt.Errorf("%w: DM Tools planning data is inconsistent: %v", ErrInvalidLegacyBackup, err)
	}
	for _, collection := range dmToolsCollections {
		file := sourceFiles[collection]
		if file == nil {
			continue
		}
		description, _ := target.report.DataRegistry().Description(datacontract.Collection, collection)
		records := recordsByCollection[collection]
		keys := make([]string, 0, len(records))
		for key := range records {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		mutations := make([]addondatastore.Mutation, 0, len(keys))
		for _, key := range keys {
			value := records[key]
			mutations = append(mutations, addondatastore.Mutation{
				Kind: addondatastore.Put, Definition: description, Key: key,
				Value: value, ExpectedRevision: 0, Audience: events.AudienceDM,
			})
		}
		if len(mutations) == 0 {
			if err := materializeEmptyAddonSet(ctx, database, "dm-tools", description, convertedAt); err != nil {
				return err
			}
		} else if err := transactAddonBatches(ctx, store, "dm-tools", target.report.ArchiveSHA256, mutations); err != nil {
			return fmt.Errorf("import legacy DM Tools %s: %w", collection, err)
		}
		report.Documents["dm-tools/collection/"+collection] = len(mutations)
		report.importedFiles = append(report.importedFiles, file)
		report.ImportedSourceFiles.Files++
		report.ImportedSourceFiles.Bytes += file.UncompressedSize64
	}
	return nil
}

func importCharacterSheets(
	ctx context.Context,
	addonStore *addondatastore.Store,
	coreStore *campaignstore.Store,
	dataset campaign.LegacyDataset,
	packages map[string]targetPackage,
	report *AddonReport,
) error {
	sheets := make(map[string]json.RawMessage)
	for _, record := range dataset.Records {
		var object map[string]json.RawMessage
		if json.Unmarshal(record.Value, &object) != nil {
			continue
		}
		addonDataBody, present := object["addonData"]
		if !present || bytes.Equal(bytes.TrimSpace(addonDataBody), []byte("null")) {
			continue
		}
		var addonData map[string]json.RawMessage
		if err := decodeJSONObject(addonDataBody, &addonData); err != nil {
			return fmt.Errorf("%w: %s:%s addonData must be an object", ErrInvalidLegacyBackup, record.Collection, record.Key)
		}
		for addonID, value := range addonData {
			if addonID == "dnd-sheets" {
				if record.Collection != campaign.Collection("characters") {
					return fmt.Errorf("%w: dnd-sheets data is attached to %s:%s", ErrInvalidLegacyBackup, record.Collection, record.Key)
				}
				sheets[record.Key] = append(json.RawMessage(nil), value...)
			} else {
				report.DeferredEmbedded[addonID]++
			}
		}
	}
	if len(sheets) == 0 {
		return nil
	}
	target, exists := packages["dnd-sheets"]
	if !exists {
		return fmt.Errorf("v1 backup contains D&D sheet data; provide its v3 ZIP with -addon-package")
	}
	description, _ := target.report.DataRegistry().Description(datacontract.RecordExtension, "dnd-sheets")
	keys := make([]string, 0, len(sheets))
	for key := range sheets {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	mutations := make([]addondatastore.Mutation, 0, len(keys))
	for _, key := range keys {
		value := sheets[key]
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			continue
		}
		var sheet map[string]json.RawMessage
		if err := decodeJSONObject(value, &sheet); err != nil {
			return fmt.Errorf("%w: character %q dnd-sheets state must be an object", ErrInvalidLegacyBackup, key)
		}
		sheet["v"] = json.RawMessage("3")
		normalized, err := json.Marshal(sheet)
		if err != nil {
			return err
		}
		if err := target.report.DataRegistry().Validate(datacontract.RecordExtension, "dnd-sheets", normalized); err != nil {
			return fmt.Errorf("%w: character %q sheet does not match the target package: %v", ErrInvalidLegacyBackup, key, err)
		}
		core, err := coreStore.Get(ctx, campaign.Collection("characters"), key)
		if err != nil {
			return fmt.Errorf("find character %q for sheet conversion: %w", key, err)
		}
		audience := events.AudiencePublic
		if core.Visibility == campaign.VisibilityDM {
			audience = events.AudienceDM
		}
		createdAt := core.CreatedAt
		mutations = append(mutations, addondatastore.Mutation{
			Kind: addondatastore.Put, Definition: description, Key: key, Value: normalized,
			ExpectedRevision: 0, TargetCreatedAt: &createdAt, Audience: audience,
		})
	}
	if len(mutations) > 0 {
		if err := transactAddonBatches(ctx, addonStore, "dnd-sheets", target.report.ArchiveSHA256, mutations); err != nil {
			return fmt.Errorf("import legacy character sheets: %w", err)
		}
	}
	report.Documents["dnd-sheets/record-extension/dnd-sheets"] = len(mutations)
	if err := stripMigratedSheets(ctx, coreStore, keys); err != nil {
		return err
	}
	report.StrippedCoreRecords = len(keys)
	return nil
}

func validateDMPlanning(records map[string]map[string]json.RawMessage) error {
	type itemView struct {
		ID       string  `json:"id"`
		Kind     string  `json:"kind"`
		ParentID *string `json:"parentId"`
	}
	type flowView struct {
		ID       string `json:"id"`
		SourceID string `json:"sourceId"`
		TargetID string `json:"targetId"`
		Kind     string `json:"kind"`
	}
	items := make(map[string]itemView, len(records["planning_items"]))
	for key, body := range records["planning_items"] {
		var item itemView
		if err := json.Unmarshal(body, &item); err != nil {
			return fmt.Errorf("decode planning item %q: %w", key, err)
		}
		items[key] = item
	}
	for _, key := range sortedRecordKeys(records["planning_items"]) {
		item := items[key]
		if item.ParentID == nil {
			continue
		}
		parent, exists := items[*item.ParentID]
		if !exists {
			return fmt.Errorf("item %q has missing parent %q", key, *item.ParentID)
		}
		if parent.Kind != "plotline" && parent.Kind != "quest" {
			return fmt.Errorf("item %q has a leaf parent", key)
		}
		seen := map[string]bool{key: true}
		current := item
		for current.ParentID != nil {
			if seen[*current.ParentID] {
				return fmt.Errorf("ownership cycle reaches %q", key)
			}
			seen[*current.ParentID] = true
			current = items[*current.ParentID]
		}
	}
	flows := make(map[string]flowView, len(records["planning_flow_links"]))
	adjacency := make(map[string][]string)
	for _, key := range sortedRecordKeys(records["planning_flow_links"]) {
		var flow flowView
		if err := json.Unmarshal(records["planning_flow_links"][key], &flow); err != nil {
			return fmt.Errorf("decode planning flow %q: %w", key, err)
		}
		flows[key] = flow
		source, sourceExists := items[flow.SourceID]
		target, targetExists := items[flow.TargetID]
		if !sourceExists || !targetExists {
			return fmt.Errorf("flow %q has a missing endpoint", key)
		}
		if !sameNullableString(source.ParentID, target.ParentID) {
			return fmt.Errorf("flow %q crosses canvas scopes", key)
		}
		if flow.Kind == "option" && source.Kind != "branch" {
			return fmt.Errorf("option flow %q does not start at a branch", key)
		}
		adjacency[flow.SourceID] = append(adjacency[flow.SourceID], flow.TargetID)
	}
	state := make(map[string]int)
	var visit func(string) error
	visit = func(id string) error {
		if state[id] == 1 {
			return fmt.Errorf("flow cycle reaches %q", id)
		}
		if state[id] == 2 {
			return nil
		}
		state[id] = 1
		for _, target := range adjacency[id] {
			if err := visit(target); err != nil {
				return err
			}
		}
		state[id] = 2
		return nil
	}
	for _, id := range sortedMapKeys(adjacency) {
		if err := visit(id); err != nil {
			return err
		}
	}
	for _, key := range sortedRecordKeys(records["planning_references"]) {
		var reference struct {
			ItemID string                     `json:"itemId"`
			Target map[string]json.RawMessage `json:"target"`
		}
		if err := json.Unmarshal(records["planning_references"][key], &reference); err != nil {
			return err
		}
		if _, exists := items[reference.ItemID]; !exists {
			return fmt.Errorf("reference %q has a missing item", key)
		}
		var scope string
		_ = json.Unmarshal(reference.Target["scope"], &scope)
		if scope == "planning" {
			var itemID string
			_ = json.Unmarshal(reference.Target["itemId"], &itemID)
			if _, exists := items[itemID]; !exists {
				return fmt.Errorf("reference %q has a missing planning target", key)
			}
		}
	}
	for _, key := range sortedRecordKeys(records["dm_notes"]) {
		var note struct {
			AnchorIDs []string `json:"anchorIds"`
		}
		if err := json.Unmarshal(records["dm_notes"][key], &note); err != nil {
			return err
		}
		for _, id := range note.AnchorIDs {
			if _, exists := items[id]; !exists {
				return fmt.Errorf("DM note %q has missing anchor %q", key, id)
			}
		}
	}
	for _, key := range sortedRecordKeys(records["planning_consequences"]) {
		var consequence struct {
			Anchor map[string]json.RawMessage `json:"anchor"`
		}
		if err := json.Unmarshal(records["planning_consequences"][key], &consequence); err != nil {
			return err
		}
		var scope string
		_ = json.Unmarshal(consequence.Anchor["scope"], &scope)
		switch scope {
		case "item":
			var id string
			_ = json.Unmarshal(consequence.Anchor["itemId"], &id)
			if _, exists := items[id]; !exists {
				return fmt.Errorf("consequence %q has a missing item anchor", key)
			}
		case "flow":
			var id string
			_ = json.Unmarshal(consequence.Anchor["flowId"], &id)
			if _, exists := flows[id]; !exists {
				return fmt.Errorf("consequence %q has a missing flow anchor", key)
			}
		default:
			return fmt.Errorf("consequence %q has an invalid anchor", key)
		}
	}
	return nil
}

func sortedRecordKeys(records map[string]json.RawMessage) []string {
	keys := make([]string, 0, len(records))
	for key := range records {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func sortedMapKeys[T any](records map[string]T) []string {
	keys := make([]string, 0, len(records))
	for key := range records {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func sameNullableString(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func stripMigratedSheets(ctx context.Context, store *campaignstore.Store, keys []string) error {
	mutations := make([]campaign.Mutation, 0, len(keys))
	for _, key := range keys {
		record, err := store.Get(ctx, campaign.Collection("characters"), key)
		if err != nil {
			return err
		}
		var object map[string]json.RawMessage
		if err := json.Unmarshal(record.Value, &object); err != nil {
			return err
		}
		var addonData map[string]json.RawMessage
		if err := json.Unmarshal(object["addonData"], &addonData); err != nil {
			return fmt.Errorf("%w: character %q addonData changed during conversion", ErrInvalidLegacyBackup, key)
		}
		delete(addonData, "dnd-sheets")
		if len(addonData) == 0 {
			delete(object, "addonData")
		} else {
			body, err := json.Marshal(addonData)
			if err != nil {
				return err
			}
			object["addonData"] = body
		}
		body, err := json.Marshal(object)
		if err != nil {
			return err
		}
		mutations = append(mutations, campaign.Mutation{
			Kind: campaign.Put, Collection: campaign.Collection("characters"), Key: key,
			Value: body, ExpectedRevision: record.Revision,
		})
	}
	for len(mutations) > 0 {
		count := min(len(mutations), campaignstore.MaximumMutations)
		if _, err := store.Transact(ctx, campaign.Transaction{
			ActorID: addonMigrationActor, Mutations: mutations[:count],
		}); err != nil {
			return fmt.Errorf("strip migrated character sheet state: %w", err)
		}
		mutations = mutations[count:]
	}
	return nil
}

func transactAddonBatches(
	ctx context.Context,
	store *addondatastore.Store,
	addonID string,
	generation string,
	mutations []addondatastore.Mutation,
) error {
	for len(mutations) > 0 {
		count := min(len(mutations), addondatastore.MaximumOperations)
		if _, err := store.Transact(ctx, addondatastore.Transaction{
			AddonID: addonID, GenerationID: generation, ActorID: addonMigrationActor,
			Mutations: mutations[:count],
		}); err != nil {
			return err
		}
		mutations = mutations[count:]
	}
	return nil
}

func materializeEmptyAddonSet(
	ctx context.Context,
	database *sql.DB,
	addonID string,
	description datacontract.Description,
	convertedAt time.Time,
) error {
	result, err := database.ExecContext(ctx, `
		INSERT INTO addon_data_sets(
			addon_id, data_kind, data_id, materialized, revision, updated_at,
			schema_version, schema_sha256, target_collection, keyed
		) VALUES (?, ?, ?, 1, 1, ?, ?, ?, NULLIF(?, ''), ?)`,
		addonID, description.Kind, description.ID, convertedAt.Format(time.RFC3339Nano),
		description.SchemaVersion, description.SchemaSHA256, description.Target, boolInt(description.Keyed),
	)
	if err != nil {
		return fmt.Errorf("materialize empty legacy add-on collection %q: %w", description.ID, err)
	}
	rows, err := result.RowsAffected()
	if err != nil || rows != 1 {
		return errors.New("materialize empty legacy add-on collection affected an unexpected row count")
	}
	return nil
}

func decodeJSONObject(body []byte, destination *map[string]json.RawMessage) error {
	decoder := json.NewDecoder(bytes.NewReader(body))
	if err := decoder.Decode(destination); err != nil || *destination == nil {
		return errors.New("expected a JSON object")
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		return errors.New("JSON contains more than one value")
	}
	return nil
}

func recordIDMatches(body json.RawMessage, key string) bool {
	var object map[string]json.RawMessage
	if json.Unmarshal(body, &object) != nil {
		return false
	}
	var id string
	return json.Unmarshal(object["id"], &id) == nil && id == key
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}
