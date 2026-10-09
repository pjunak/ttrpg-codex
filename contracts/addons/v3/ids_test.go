package addonv3

import (
	"encoding/json"
	"regexp"
	"strings"
	"testing"
)

func TestValidAddonIDMatchesManifestSchema(t *testing.T) {
	var manifest struct {
		Defs struct {
			AddonID struct {
				Pattern   string `json:"pattern"`
				MaxLength int    `json:"maxLength"`
			} `json:"addonId"`
		} `json:"$defs"`
	}
	if err := json.Unmarshal(ManifestSchema(), &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.Defs.AddonID.MaxLength != MaxAddonIDLength {
		t.Fatalf("schema maxLength %d, Go limit %d", manifest.Defs.AddonID.MaxLength, MaxAddonIDLength)
	}
	pattern := regexp.MustCompile(manifest.Defs.AddonID.Pattern)
	for _, value := range []string{
		"", "a", "notes", "dm-tools", "dnd-2024-compendium", "a1-b2", "1notes", "-notes", "notes-",
		"dm--tools", "DM-tools", "dm_tools", "dm.tools", "dm tools", "ž", "notes\n",
		strings.Repeat("a", MaxAddonIDLength), strings.Repeat("a", MaxAddonIDLength+1),
	} {
		schema := len(value) <= MaxAddonIDLength && pattern.MatchString(value)
		if got := ValidAddonID(value); got != schema {
			t.Errorf("ValidAddonID(%q) = %v, schema says %v", value, got, schema)
		}
	}
}
