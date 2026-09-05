package legacyconvert

import (
	"bytes"
	"encoding/json"
	"fmt"

	"github.com/pjunak/ttrpg-codex/internal/domain/campaign"
)

type legacySidebarSection struct {
	ID          string   `json:"id"`
	Label       string   `json:"label"`
	Icon        string   `json:"icon"`
	Collapsible bool     `json:"collapsible"`
	DefaultOpen bool     `json:"defaultOpen"`
	Role        string   `json:"role"`
	Pages       []string `json:"pages"`
}

// Materialize v1's effective defaults only at the offline boundary. Depending
// on the new host's default navigation would change an uncustomized campaign.
func normalizeSidebarSettings(backup *legacyBackup) error {
	layoutIndex := -1
	var hiddenValue json.RawMessage
	var nextPosition int64
	for index, record := range backup.dataset.Records {
		if record.Collection != campaign.Settings {
			continue
		}
		if record.Position >= nextPosition {
			nextPosition = record.Position + 1
		}
		switch record.Key {
		case "sidebarLayout":
			if !bytes.Equal(bytes.TrimSpace(record.Value), []byte("null")) {
				return nil // Saved layouts take precedence over the retired hide list.
			}
			layoutIndex = index
		case "hiddenSidebarPages":
			hiddenValue = record.Value
		}
	}
	var hidden []string
	if len(hiddenValue) != 0 && !bytes.Equal(bytes.TrimSpace(hiddenValue), []byte("null")) {
		// Decode each entry explicitly: encoding/json accepts null into a string.
		var entries []json.RawMessage
		if err := json.Unmarshal(hiddenValue, &entries); err != nil || len(entries) > 128 {
			return fmt.Errorf("%w: hiddenSidebarPages must be a bounded list of routes", ErrInvalidLegacyBackup)
		}
		for _, entry := range entries {
			var route string
			if len(entry) == 0 || entry[0] != '"' || json.Unmarshal(entry, &route) != nil || len(route) > 256 {
				return fmt.Errorf("%w: hiddenSidebarPages must contain route strings", ErrInvalidLegacyBackup)
			}
			hidden = append(hidden, route)
		}
	}
	layout := struct {
		Sections []legacySidebarSection `json:"sections"`
		Hidden   []string               `json:"hidden"`
	}{
		Sections: []legacySidebarSection{
			{ID: "prehled", Label: "Overview", DefaultOpen: true, Pages: []string{"/", "/mapa/svet"}},
			{ID: "kampan", Label: "Campaign", DefaultOpen: true, Pages: []string{"/casova-osa", "/zahady", "/mapa/palac"}},
			{ID: "svet", Label: "World", DefaultOpen: true, Pages: []string{"/mista", "/postavy", "/frakce", "/mazlicci"}},
			{ID: "kompendium", Label: "Compendium", Collapsible: true, Pages: []string{"/panteon", "/artefakty", "/historie"}},
			{ID: "dm", Label: "DM", DefaultOpen: true, Role: "dm", Pages: []string{"/dm"}},
		},
		Hidden: []string{},
	}
	known := make(map[string]bool)
	for _, section := range layout.Sections {
		for _, route := range section.Pages {
			known[route] = true
		}
	}
	hide := make(map[string]bool)
	for _, route := range hidden {
		if known[route] && !hide[route] {
			hide[route] = true
			layout.Hidden = append(layout.Hidden, route)
		}
	}
	for index := range layout.Sections {
		pages := []string{}
		for _, route := range layout.Sections[index].Pages {
			if !hide[route] {
				pages = append(pages, route)
			}
		}
		layout.Sections[index].Pages = pages
	}
	body, err := json.Marshal(layout)
	if err != nil {
		return err
	}
	if layoutIndex >= 0 {
		backup.dataset.Records[layoutIndex].Value = body
	} else {
		if _, present := backup.report.CoreCollections[string(campaign.Settings)]; !present {
			backup.dataset.Present = append(backup.dataset.Present, campaign.Settings)
		}
		backup.dataset.Records = append(backup.dataset.Records, campaign.LegacyRecord{
			Collection: campaign.Settings, Key: "sidebarLayout", Value: body, Position: nextPosition,
		})
		backup.report.CoreCollections[string(campaign.Settings)]++
	}
	backup.report.Legacy.SidebarLayouts++
	return nil
}
