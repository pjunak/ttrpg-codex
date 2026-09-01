package legacyconvert

import (
	"archive/zip"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/pjunak/ttrpg-codex/internal/domain/campaign"
)

const (
	legacySpeciesFilename = "data/species.json"
	legacyMapPinsFilename = "data/mapPins.json"
)

// normalizeRetiredCoreData preserves the useful meaning of two collections
// retired before the v2 rewrite. It is intentionally narrow: unknown shapes
// fail conversion rather than becoming a permanent compatibility surface.
func normalizeRetiredCoreData(backup *legacyBackup) error {
	if file := backup.files[legacySpeciesFilename]; file != nil {
		definitions, err := readLegacySpecies(file)
		if err != nil {
			return err
		}
		mapped, err := mapLegacyCharacterSpecies(&backup.dataset, definitions)
		if err != nil {
			return err
		}
		if err := consumeDeferredFile(&backup.report, "other", file.UncompressedSize64); err != nil {
			return err
		}
		backup.report.Legacy.SpeciesDefinitions = len(definitions)
		backup.report.Legacy.CharacterSpecies = mapped
	}

	if file := backup.files[legacyMapPinsFilename]; file != nil {
		body, err := readZipFile(file, campaign.MaximumLegacyDatasetBytes)
		if err != nil {
			return err
		}
		var pins []json.RawMessage
		if err := json.Unmarshal(body, &pins); err != nil || pins == nil {
			return fmt.Errorf("%w: %s must contain an array", ErrInvalidLegacyBackup, legacyMapPinsFilename)
		}
		if len(pins) != 0 {
			return fmt.Errorf(
				"%w: %s still contains %d records; map pins cannot be discarded safely",
				ErrInvalidLegacyBackup,
				legacyMapPinsFilename,
				len(pins),
			)
		}
		if err := consumeDeferredFile(&backup.report, "other", file.UncompressedSize64); err != nil {
			return err
		}
		backup.report.Legacy.DiscardedMapPinFile = 1
	}
	return nil
}

func readLegacySpecies(file *zip.File) (map[string]string, error) {
	body, err := readZipFile(file, campaign.MaximumLegacyDatasetBytes)
	if err != nil {
		return nil, err
	}
	var records []json.RawMessage
	if err := json.Unmarshal(body, &records); err != nil || records == nil {
		return nil, fmt.Errorf("%w: %s must contain an array", ErrInvalidLegacyBackup, legacySpeciesFilename)
	}
	result := make(map[string]string, len(records))
	for index, raw := range records {
		var record struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		}
		if err := json.Unmarshal(raw, &record); err != nil {
			return nil, fmt.Errorf("%w: %s record %d must be an object", ErrInvalidLegacyBackup, legacySpeciesFilename, index)
		}
		name := strings.TrimSpace(record.Name)
		if record.ID == "" || record.ID != strings.TrimSpace(record.ID) || len(record.ID) > 256 ||
			name == "" || len(name) > 500 {
			return nil, fmt.Errorf("%w: %s record %d has an invalid id or name", ErrInvalidLegacyBackup, legacySpeciesFilename, index)
		}
		if _, duplicate := result[record.ID]; duplicate {
			return nil, fmt.Errorf("%w: %s contains duplicate id %q", ErrInvalidLegacyBackup, legacySpeciesFilename, record.ID)
		}
		result[record.ID] = name
	}
	return result, nil
}

func mapLegacyCharacterSpecies(dataset *campaign.LegacyDataset, definitions map[string]string) (int, error) {
	mapped := 0
	for index := range dataset.Records {
		record := &dataset.Records[index]
		if record.Collection != campaign.Characters {
			continue
		}
		var object map[string]json.RawMessage
		if err := json.Unmarshal(record.Value, &object); err != nil {
			return 0, fmt.Errorf("%w: decode character %q", ErrInvalidLegacyBackup, record.Key)
		}
		rawSpecies, present := object["species"]
		if !present {
			continue
		}
		var species string
		if err := json.Unmarshal(rawSpecies, &species); err != nil {
			return 0, fmt.Errorf("%w: character %q species must be a string", ErrInvalidLegacyBackup, record.Key)
		}
		name, known := definitions[species]
		if !known {
			continue
		}
		object["species"], _ = json.Marshal(name)
		normalized, err := json.Marshal(object)
		if err != nil {
			return 0, fmt.Errorf("encode character %q species: %w", record.Key, err)
		}
		record.Value = normalized
		mapped++
	}
	return mapped, nil
}

func consumeDeferredFile(report *Report, group string, size uint64) error {
	value, exists := report.Deferred[group]
	if !exists || value.Files < 1 || value.Bytes < size {
		return errors.New("legacy conversion inventory is inconsistent")
	}
	value.Files--
	value.Bytes -= size
	report.Deferred[group] = value
	return nil
}
