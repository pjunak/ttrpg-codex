package addondata

import (
	"encoding/json"
	"fmt"

	"github.com/pjunak/ttrpg-codex/internal/addons/datacontract"
)

// Every path that adopts data under a registry uses the same uniqueness rule.
func validateUniqueValues(definition datacontract.Description, prospective map[string]json.RawMessage) error {
	for _, index := range definition.Indexes {
		if !index.Unique {
			continue
		}
		seen := make(map[string]string)
		for key, body := range prospective {
			value, found, err := jsonPointer(body, index.Path)
			if err != nil {
				return fmt.Errorf("%w: index %q", ErrInvalidRequest, index.Path)
			}
			if !found {
				continue
			}
			canonical, err := json.Marshal(value)
			if err != nil {
				return ErrInvalidRequest
			}
			identity := string(canonical)
			if previous, duplicate := seen[identity]; duplicate && previous != key {
				return fmt.Errorf("%w: %s %q conflicts for %s and %s", ErrUniqueIndexConflict, definition.ID, index.Path, previous, key)
			}
			seen[identity] = key
		}
	}
	return nil
}
