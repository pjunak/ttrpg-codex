package packagemanager

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"unicode"

	"github.com/pjunak/ttrpg-codex/internal/addons/packageinspect"
	"github.com/pjunak/ttrpg-codex/internal/events"
)

type browserGraphState struct {
	AddonID            string `json:"addonId"`
	ActiveGenerationID string `json:"activeGenerationId"`
	Revision           int64  `json:"revision"`
}

const BrowserGraphContractVersion = 2

// BrowserGraph projects only recovered, server-authoritative UI generations.
// Its opaque revision also includes every durable active add-on state, so a
// worker-only reload or provider cohort can force browser SDK handles to be
// rebuilt even when UI package URLs remain unchanged.
func (manager *Manager) BrowserGraph(ctx context.Context) (BrowserGraph, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	return manager.browserGraphLocked(ctx)
}

func (manager *Manager) browserGraphLocked(ctx context.Context) (BrowserGraph, error) {
	states, err := manager.store.activeStates(ctx)
	if err != nil {
		return BrowserGraph{}, err
	}
	revisionStates := make([]browserGraphState, 0, len(states))
	recoveredUI := make(map[string]activeRuntime, len(states))
	for _, state := range states {
		active, recovered := manager.runtimes[state.AddonID]
		if recovered && active.generation.GenerationID == state.ActiveGenerationID &&
			active.report.Manifest.Runtime != nil && active.report.Manifest.Runtime.UI != nil {
			recoveredUI[state.AddonID] = active
		}
	}
	addOns := make([]BrowserGeneration, 0)
	for _, state := range states {
		revisionStates = append(revisionStates, browserGraphState{
			AddonID: state.AddonID, ActiveGenerationID: state.ActiveGenerationID,
			Revision: state.Revision,
		})
		active, recovered := recoveredUI[state.AddonID]
		if !recovered {
			continue
		}
		ui := active.report.Manifest.Runtime.UI
		capabilities, capabilityErr := manager.browserCapabilities(active.report.Manifest)
		if capabilityErr != nil {
			return BrowserGraph{}, capabilityErr
		}
		approved, _, permissionErr := approvedPermissions(
			active.report.Manifest.Permissions,
			state.GrantedPermissionIDs,
		)
		if permissionErr != nil {
			return BrowserGraph{}, fmt.Errorf("project browser permissions for %s: %w", state.AddonID, permissionErr)
		}
		contributions, contributionErr := browserContributions(
			active.report.Manifest.Contributions,
			capabilities,
		)
		if contributionErr != nil {
			return BrowserGraph{}, fmt.Errorf("project browser contributions for %s: %w", state.AddonID, contributionErr)
		}
		generation := BrowserGeneration{
			AddonID: state.AddonID, AddonVersion: active.generation.Version,
			GenerationID: active.generation.GenerationID, Mode: ui.Mode,
			EntryURL:      browserAssetURL(state.AddonID, active.generation.GenerationID, ui.Entry),
			StyleURLs:     make([]string, 0, len(ui.Styles)),
			Sandbox:       append([]string{}, ui.Sandbox...),
			Dependencies:  make([]string, 0),
			Capabilities:  capabilities,
			Permissions:   browserPermissions(approved),
			Contributions: contributions,
		}
		for _, style := range ui.Styles {
			generation.StyleURLs = append(
				generation.StyleURLs,
				browserAssetURL(state.AddonID, active.generation.GenerationID, style),
			)
		}
		for _, dependency := range active.report.Manifest.Dependencies {
			if !dependency.Required {
				continue
			}
			if _, exists := recoveredUI[dependency.ID]; exists {
				generation.Dependencies = append(generation.Dependencies, dependency.ID)
			}
		}
		sort.Strings(generation.StyleURLs)
		sort.Strings(generation.Sandbox)
		sort.Strings(generation.Dependencies)
		addOns = append(addOns, generation)
	}
	sort.Slice(addOns, func(left, right int) bool { return addOns[left].AddonID < addOns[right].AddonID })
	body, err := json.Marshal(struct {
		ContractVersion int                 `json:"contractVersion"`
		States          []browserGraphState `json:"states"`
		Addons          []BrowserGeneration `json:"addons"`
	}{ContractVersion: BrowserGraphContractVersion, States: revisionStates, Addons: addOns})
	if err != nil {
		return BrowserGraph{}, fmt.Errorf("encode browser graph revision: %w", err)
	}
	digest := sha256.Sum256(body)
	return BrowserGraph{
		ContractVersion: BrowserGraphContractVersion,
		GraphRevision:   hex.EncodeToString(digest[:]), Addons: addOns,
	}, nil
}

func (manager *Manager) publishBrowserGraphChangeLocked(
	ctx context.Context,
	addonID string,
	reason string,
) {
	if manager.eventPublisher == nil {
		return
	}
	graph, err := manager.browserGraphLocked(ctx)
	if err == nil {
		_, err = manager.eventPublisher.Publish(ctx, events.Publication{
			Audience: events.AudiencePublic, Topic: "browser-addons-changed",
			ResourceID: addonID, Revision: graph.GraphRevision,
			Metadata: map[string]any{"reason": reason},
		})
	}
	if err != nil {
		manager.logger.Error(
			"publish browser add-on graph change",
			"addonId", addonID, "reason", reason, "error", err,
		)
	}
}

func (manager *Manager) browserCapabilities(manifest packageinspect.Manifest) ([]string, error) {
	capabilities := make([]string, 0,
		len(manifest.Capabilities.Required)+len(manifest.Capabilities.Optional))
	for _, capability := range manifest.Capabilities.Required {
		if _, available := manager.capabilities[capability]; !available {
			return nil, fmt.Errorf("project browser capabilities for %s: %w: %s",
				manifest.ID, ErrCapability, capability)
		}
		capabilities = append(capabilities, capability)
	}
	for _, capability := range manifest.Capabilities.Optional {
		if _, available := manager.capabilities[capability]; available {
			capabilities = append(capabilities, capability)
		}
	}
	sort.Strings(capabilities)
	return capabilities, nil
}

func browserPermissions(permissions []packageinspect.Permission) []BrowserPermission {
	result := make([]BrowserPermission, 0, len(permissions))
	for _, permission := range permissions {
		resources := append([]string{}, permission.Resources...)
		sort.Strings(resources)
		result = append(result, BrowserPermission{ID: permission.ID, Resources: resources})
	}
	sort.Slice(result, func(left, right int) bool { return result[left].ID < result[right].ID })
	return result
}

func browserContributions(
	contributions []packageinspect.Contribution,
	capabilities []string,
) ([]BrowserContribution, error) {
	available := make(map[string]struct{}, len(capabilities))
	for _, capability := range capabilities {
		available[capability] = struct{}{}
	}
	result := make([]BrowserContribution, 0, len(contributions))
	for _, contribution := range contributions {
		if !isBrowserContribution(contribution.Surface) ||
			!hasBrowserContributionCapabilities(contribution.Requires, available) {
			continue
		}
		config, err := cloneBrowserContributionConfig(contribution.Config)
		if err != nil {
			return nil, err
		}
		roles := append([]string{}, contribution.Roles...)
		requires := append([]string{}, contribution.Requires...)
		sort.Strings(roles)
		sort.Strings(requires)
		result = append(result, BrowserContribution{
			ID: contribution.ID, Surface: contribution.Surface, Label: contribution.Label,
			Roles: roles, Order: contribution.Order, Requires: requires, Config: config,
		})
	}
	sort.Slice(result, func(left, right int) bool { return result[left].ID < result[right].ID })
	return result, nil
}

func isBrowserContribution(surface string) bool {
	switch surface {
	case "route", "sidebar", "settings", "article-action", "article-section",
		"editor-panel", "slot", "record-renderer", "wiki-kind",
		"graph-node-kind", "graph-view", "graph-contributor":
		return true
	default:
		return false
	}
}

func hasBrowserContributionCapabilities(
	required []string,
	available map[string]struct{},
) bool {
	for _, capability := range required {
		if _, exists := available[capability]; !exists {
			return false
		}
	}
	return true
}

func cloneBrowserContributionConfig(config map[string]any) (map[string]any, error) {
	if len(config) == 0 {
		return map[string]any{}, nil
	}
	body, err := json.Marshal(config)
	if err != nil {
		return nil, fmt.Errorf("encode contribution config: %w", err)
	}
	clone := make(map[string]any, len(config))
	if err := json.Unmarshal(body, &clone); err != nil {
		return nil, fmt.Errorf("decode contribution config: %w", err)
	}
	return clone, nil
}

func browserAssetURL(addonID string, generationID string, packagePath string) string {
	parts := strings.Split(packagePath, "/")
	for index := range parts {
		parts[index] = url.PathEscape(parts[index])
	}
	return "/api/addons/" + url.PathEscape(addonID) +
		"/generations/" + url.PathEscape(generationID) +
		"/assets/" + strings.Join(parts, "/")
}

// OpenBrowserAsset opens one inventory-backed file under the web subtree of
// an exact recovered generation. Inactive, stale, undeclared, and non-web
// paths are indistinguishable to callers. Expected files are hashed through
// the opened handle before it is returned, so local generation corruption
// cannot be served as trusted browser code.
func (manager *Manager) OpenBrowserAsset(
	ctx context.Context,
	addonID string,
	generationID string,
	packagePath string,
) (BrowserAsset, error) {
	if err := ctx.Err(); err != nil {
		return BrowserAsset{}, err
	}
	if !validAddonPath(addonID) || !validGenerationID(generationID) ||
		!validBrowserAssetPath(packagePath) {
		return BrowserAsset{}, ErrBrowserAssetNotFound
	}

	manager.mu.Lock()
	active, recovered := manager.runtimes[addonID]
	if !recovered || active.generation.GenerationID != generationID ||
		active.report.Manifest.Runtime == nil || active.report.Manifest.Runtime.UI == nil {
		manager.mu.Unlock()
		return BrowserAsset{}, ErrBrowserAssetNotFound
	}
	var expected *packageinspect.File
	for index := range active.report.Files {
		if active.report.Files[index].Path == packagePath {
			copy := active.report.Files[index]
			expected = &copy
			break
		}
	}
	rootDirectory := filepath.Join(manager.generationDirectory(addonID, generationID), "root")
	manager.mu.Unlock()
	if expected == nil {
		return BrowserAsset{}, ErrBrowserAssetNotFound
	}

	root, err := os.OpenRoot(rootDirectory)
	if err != nil {
		return BrowserAsset{}, fmt.Errorf("%w: open generation root: %v", ErrInvalidPackage, err)
	}
	file, openErr := root.Open(filepath.FromSlash(packagePath))
	closeRootErr := root.Close()
	if openErr != nil {
		return BrowserAsset{}, fmt.Errorf("%w: open browser asset: %v", ErrInvalidPackage, openErr)
	}
	if closeRootErr != nil {
		_ = file.Close()
		return BrowserAsset{}, fmt.Errorf("%w: close generation root: %v", ErrInvalidPackage, closeRootErr)
	}
	if err := verifyBrowserAsset(ctx, file, *expected); err != nil {
		_ = file.Close()
		return BrowserAsset{}, fmt.Errorf("%w: %v", ErrInvalidPackage, err)
	}
	return BrowserAsset{
		Path: packagePath, SHA256: expected.SHA256, Bytes: expected.Bytes, Content: file,
	}, nil
}

func validBrowserAssetPath(value string) bool {
	if value == "" || len(value) > 2_000 || strings.Contains(value, "\\") ||
		strings.HasPrefix(value, "/") || path.Clean(value) != value ||
		!strings.HasPrefix(value, "web/") || value == "web/" {
		return false
	}
	for _, character := range value {
		if character == 0 || unicode.IsControl(character) {
			return false
		}
	}
	return true
}

func verifyBrowserAsset(ctx context.Context, file *os.File, expected packageinspect.File) error {
	info, err := file.Stat()
	if err != nil {
		return fmt.Errorf("stat %s: %w", expected.Path, err)
	}
	if !info.Mode().IsRegular() || info.Size() < 0 || uint64(info.Size()) != expected.Bytes {
		return fmt.Errorf("%s is not the expected regular file", expected.Path)
	}
	hash := sha256.New()
	written, err := io.Copy(
		hash,
		io.LimitReader(&contextReader{ctx: ctx, reader: file}, int64(expected.Bytes)+1),
	)
	if err != nil {
		return fmt.Errorf("hash %s: %w", expected.Path, err)
	}
	if uint64(written) != expected.Bytes || hex.EncodeToString(hash.Sum(nil)) != expected.SHA256 {
		return fmt.Errorf("%s checksum does not match its package inventory", expected.Path)
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return fmt.Errorf("rewind %s: %w", expected.Path, err)
	}
	return nil
}
