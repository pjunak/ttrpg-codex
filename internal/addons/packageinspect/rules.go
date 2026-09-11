package packageinspect

import (
	"errors"
	"slices"

	"github.com/pjunak/ttrpg-codex/internal/addons/contentcontract"
)

func validateRules(manifest Manifest, content *contentcontract.Registry) error {
	if manifest.Rules == nil || manifest.Rules.Defines == nil {
		return nil
	}
	definition := manifest.Rules.Defines
	if !slices.Contains(manifest.Rules.Supports, definition.ID) {
		return errors.New("a defining rules package must support its own ruleset")
	}
	if _, err := content.Get(definition.ContentSet, definition.RecordKind, definition.RecordID); err != nil {
		return errors.New("the declared complete rules profile is not in the package content")
	}
	for _, provider := range manifest.Services.Provides {
		if provider.Contract == definition.Contract && provider.Transport == "content" {
			return nil
		}
	}
	return errors.New("the defining rules package must publish its declared content service")
}
