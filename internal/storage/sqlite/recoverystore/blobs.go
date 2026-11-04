package recoverystore

import (
	"encoding/json"
	"fmt"
	"regexp"
)

var blobIDPattern = regexp.MustCompile(`b_[0-9a-f]{32}`)

// BlobReferences adds every blob ID mentioned anywhere in the JSON body to
// keep, including IDs in unknown or extension fields.
func BlobReferences(body []byte, keep map[string]bool) error {
	var value any
	if err := json.Unmarshal(body, &value); err != nil {
		return err
	}
	var walk func(any)
	walk = func(v any) {
		switch item := v.(type) {
		case string:
			for _, id := range blobIDPattern.FindAllString(item, -1) {
				keep[id] = true
			}
			// Recovery stores document bodies as JSON strings, which may themselves
			// contain escaped identifiers. Decode that extra layer before scanning.
			if json.Valid([]byte(item)) {
				var nested any
				if json.Unmarshal([]byte(item), &nested) == nil {
					switch nested.(type) {
					case map[string]any, []any:
						walk(nested)
					}
				}
			}
		case map[string]any:
			for _, child := range item {
				walk(child)
			}
		case []any:
			for _, child := range item {
				walk(child)
			}
		}
	}
	walk(value)
	return nil
}

// ImageBlobs adds the blobs a recovery image keeps alive to keep: its live
// handles and every blob its records, documents or media bindings mention.
// The offline collector keeps exactly these objects, and a backup bundle
// carries exactly these files.
func ImageBlobs(image []byte, keep map[string]bool) error {
	var parsed map[string]json.RawMessage
	if err := json.Unmarshal(image, &parsed); err != nil {
		return err
	}
	var handles []struct {
		ID      string `json:"blob_id"`
		Deleted int    `json:"deleted"`
	}
	if err := json.Unmarshal(parsed["blobs"], &handles); err != nil {
		return fmt.Errorf("recovery image blobs: %w", err)
	}
	for _, handle := range handles {
		if handle.Deleted == 0 {
			keep[handle.ID] = true
		}
	}
	for _, field := range []string{"records", "documents", "assets"} {
		if err := BlobReferences(parsed[field], keep); err != nil {
			return fmt.Errorf("recovery image %s: %w", field, err)
		}
	}
	return nil
}
