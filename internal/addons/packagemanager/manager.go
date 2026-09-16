package packagemanager

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	semver "github.com/Masterminds/semver/v3"
	"github.com/pjunak/ttrpg-codex/internal/addons/contentcontract"
	"github.com/pjunak/ttrpg-codex/internal/addons/contenttransport"
	"github.com/pjunak/ttrpg-codex/internal/addons/datalifecycle"
	"github.com/pjunak/ttrpg-codex/internal/addons/packageinspect"
	"github.com/pjunak/ttrpg-codex/internal/addons/servicebroker"
	"github.com/pjunak/ttrpg-codex/internal/addons/workersupervisor"
	"github.com/pjunak/ttrpg-codex/internal/events"
)

const defaultMaxArchiveBytes int64 = 128 << 20

var addonIDPattern = regexp.MustCompile(`^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`)

type Config struct {
	DB                    *sql.DB
	PackageDirectory      string
	Inspector             *packageinspect.Inspector
	Broker                *servicebroker.Broker
	DataLifecycle         datalifecycle.Coordinator
	RuntimeFactory        RuntimeFactory
	HostVersion           string
	AddonAPIVersion       string
	WorkerProtocolVersion string
	AvailableCapabilities []string
	MaxArchiveBytes       int64
	Now                   func() time.Time
	GenerateID            func() (string, error)
	Logger                *slog.Logger
	EventPublisher        EventPublisher
	Monitoring            *MonitoringConfig
}

type EventPublisher interface {
	Publish(context.Context, events.Publication) (events.Event, error)
}

type activeRuntime struct {
	generation Generation
	report     packageinspect.Report
	content    *contentcontract.Registry
	runtime    Runtime
	services   []servicebroker.Handle
}

type Manager struct {
	automaticCleanup      bool
	packageFetcher        PackageFetcher
	store                 *store
	directory             string
	stagingDirectory      string
	inspector             *packageinspect.Inspector
	broker                *servicebroker.Broker
	dataLifecycle         datalifecycle.Coordinator
	runtimeFactory        RuntimeFactory
	hostVersion           *semver.Version
	addonAPIVersion       *semver.Version
	workerProtocolVersion *semver.Version
	capabilities          map[string]struct{}
	maxArchiveBytes       int64
	generateID            func() (string, error)
	logger                *slog.Logger
	eventPublisher        EventPublisher

	monitorMu       sync.Mutex
	monitorCancel   context.CancelFunc
	monitorDone     chan struct{}
	monitoring      *workerMonitor
	mu              sync.Mutex
	runtimes        map[string]activeRuntime
	contentRevision int64
	contentCache    map[string]*contentcontract.Registry
}

func New(config Config) (*Manager, error) {
	if config.Inspector == nil || config.Broker == nil || config.DataLifecycle == nil {
		return nil, fmt.Errorf("%w: inspector, service broker, and data lifecycle are required", ErrInvalidConfig)
	}
	if config.PackageDirectory == "" {
		return nil, fmt.Errorf("%w: package directory is required", ErrInvalidConfig)
	}
	directory, err := filepath.Abs(config.PackageDirectory)
	if err != nil {
		return nil, fmt.Errorf("%w: resolve package directory: %v", ErrInvalidConfig, err)
	}
	if filepath.Dir(directory) == directory {
		return nil, fmt.Errorf("%w: filesystem root cannot be the package directory", ErrInvalidConfig)
	}
	if err := os.MkdirAll(directory, 0o750); err != nil {
		return nil, fmt.Errorf("create package directory: %w", err)
	}
	stagingDirectory := filepath.Join(directory, ".staging")
	if err := os.MkdirAll(stagingDirectory, 0o750); err != nil {
		return nil, fmt.Errorf("create package staging directory: %w", err)
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	store, err := newStore(config.DB, config.Now)
	if err != nil {
		return nil, err
	}
	hostVersion, err := semver.StrictNewVersion(config.HostVersion)
	if err != nil {
		return nil, fmt.Errorf("%w: invalid host version %q", ErrInvalidConfig, config.HostVersion)
	}
	addonAPIVersion, err := semver.StrictNewVersion(config.AddonAPIVersion)
	if err != nil {
		return nil, fmt.Errorf("%w: invalid Add-on API version %q", ErrInvalidConfig, config.AddonAPIVersion)
	}
	workerProtocolVersion, err := semver.StrictNewVersion(config.WorkerProtocolVersion)
	if err != nil {
		return nil, fmt.Errorf("%w: invalid worker protocol version %q", ErrInvalidConfig, config.WorkerProtocolVersion)
	}
	capabilities := make(map[string]struct{}, len(config.AvailableCapabilities))
	for _, capability := range config.AvailableCapabilities {
		if capability == "" {
			return nil, fmt.Errorf("%w: empty available capability", ErrInvalidConfig)
		}
		capabilities[capability] = struct{}{}
	}
	if config.MaxArchiveBytes <= 0 {
		config.MaxArchiveBytes = defaultMaxArchiveBytes
	}
	if config.GenerateID == nil {
		config.GenerateID = randomID
	}
	if config.Logger == nil {
		config.Logger = slog.Default()
	}
	monitoring, err := newWorkerMonitor(config.Monitoring)
	if err != nil {
		return nil, fmt.Errorf("configure worker monitoring: %w", err)
	}
	return &Manager{
		monitoring:            monitoring,
		store:                 store,
		directory:             directory,
		stagingDirectory:      stagingDirectory,
		inspector:             config.Inspector,
		broker:                config.Broker,
		dataLifecycle:         config.DataLifecycle,
		runtimeFactory:        config.RuntimeFactory,
		hostVersion:           hostVersion,
		addonAPIVersion:       addonAPIVersion,
		workerProtocolVersion: workerProtocolVersion,
		capabilities:          capabilities,
		maxArchiveBytes:       config.MaxArchiveBytes,
		generateID:            config.GenerateID,
		logger:                config.Logger,
		eventPublisher:        config.EventPublisher,
		runtimes:              make(map[string]activeRuntime),
	}, nil
}

// Stage copies, validates, and extracts one package into a content-addressed
// immutable generation directory. It records no grants and changes no active
// runtime or provider catalog.
func (manager *Manager) Stage(ctx context.Context, archivePath string) (Generation, error) {
	input, err := os.Open(archivePath)
	if err != nil {
		return Generation{}, fmt.Errorf("open package source: %w", err)
	}
	defer input.Close()
	info, err := input.Stat()
	if err != nil {
		return Generation{}, fmt.Errorf("stat package source: %w", err)
	}
	if !info.Mode().IsRegular() {
		return Generation{}, fmt.Errorf("package source is not a regular file")
	}
	if info.Size() > manager.maxArchiveBytes {
		return Generation{}, fmt.Errorf("package source exceeds %d bytes", manager.maxArchiveBytes)
	}
	return manager.stageArchive(ctx, input, nil)
}

// StageArchive validates and publishes an uploaded package without exposing a
// caller-controlled filesystem path to the lifecycle boundary.
func (manager *Manager) StageArchive(ctx context.Context, archive io.Reader) (Generation, error) {
	if archive == nil {
		return Generation{}, fmt.Errorf("%w: package archive is required", ErrInvalidPackage)
	}
	return manager.stageArchive(ctx, archive, nil)
}

// StageUpdateArchive binds a slow remote download to the installation that
// requested it. Completion after uninstall or another transition cannot reinstall.
func (manager *Manager) StageUpdateArchive(ctx context.Context, archive io.Reader, addonID string, expectedRevision int64) (Generation, error) {
	if archive == nil || !validAddonPath(addonID) || expectedRevision < 0 {
		return Generation{}, ErrInvalidPackage
	}
	return manager.stageArchive(ctx, archive, &State{AddonID: addonID, Revision: expectedRevision})
}

func (manager *Manager) stageArchive(ctx context.Context, archive io.Reader, expected *State) (Generation, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	return manager.stageArchiveLocked(ctx, archive, expected)
}

func (manager *Manager) stageArchiveLocked(ctx context.Context, archive io.Reader, expected *State) (Generation, error) {
	if expected != nil {
		snapshot, err := manager.store.snapshot(ctx, expected.AddonID, 1)
		if err != nil {
			return Generation{}, err
		}
		if snapshot.State.Revision != expected.Revision {
			return Generation{}, ErrStaleActivationPlan
		}
	}
	stageID, err := manager.generateID()
	if err != nil {
		return Generation{}, fmt.Errorf("generate staging ID: %w", err)
	}
	if !validStageID(stageID) {
		return Generation{}, fmt.Errorf("%w: generated staging ID is invalid", ErrInvalidConfig)
	}
	stageDirectory := filepath.Join(manager.stagingDirectory, stageID)
	if err := os.Mkdir(stageDirectory, 0o750); err != nil {
		return Generation{}, fmt.Errorf("create package stage: %w", err)
	}
	stagePublished := false
	defer func() {
		if !stagePublished {
			_ = manager.removeStage(stageDirectory)
		}
	}()
	stagedArchive := filepath.Join(stageDirectory, "package.zip")
	if err := copyBoundedArchive(ctx, archive, stagedArchive, manager.maxArchiveBytes); err != nil {
		return Generation{}, err
	}
	report, err := manager.inspector.InspectAndExtractFile(ctx, stagedArchive, filepath.Join(stageDirectory, "root"))
	if err != nil {
		return Generation{}, fmt.Errorf("%w: %v", ErrInvalidPackage, err)
	}
	if !validAddonPath(report.Manifest.ID) {
		return Generation{}, fmt.Errorf("%w: add-on id is not a safe package path", ErrInvalidPackage)
	}
	if expected != nil && report.Manifest.ID != expected.AddonID {
		return Generation{}, ErrInvalidPackage
	}
	generationID := report.ArchiveSHA256
	var pending bool
	if err := manager.store.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM addon_package_cleanups c, json_each(c.review_json, '$.generations') g WHERE c.status='pending' AND g.value ->> 'remove' = 1 AND g.value ->> 'addonId' = ? AND g.value ->> 'generationId' = ?)`, report.Manifest.ID, generationID).Scan(&pending); err != nil {
		return Generation{}, err
	}
	if err := manager.store.db.QueryRowContext(ctx, `SELECT ? OR EXISTS(SELECT 1 FROM addon_package_files WHERE addon_id=? AND generation_id=? AND status='pending')`, pending, report.Manifest.ID, generationID).Scan(&pending); err != nil {
		return Generation{}, err
	}
	if pending {
		return Generation{}, ErrCleanupPending
	}
	finalDirectory := manager.generationDirectory(report.Manifest.ID, generationID)
	if err := os.MkdirAll(filepath.Dir(finalDirectory), 0o750); err != nil {
		return Generation{}, fmt.Errorf("create generation parent: %w", err)
	}
	if _, err := os.Lstat(finalDirectory); err == nil {
		existing, loadErr := manager.loadPackage(ctx, report.Manifest.ID, generationID)
		if loadErr != nil {
			removed, err := manager.store.uninstallHash(ctx, report.Manifest.ID)
			if err != nil {
				return Generation{}, err
			}
			if removed == "" {
				return Generation{}, fmt.Errorf("%w: existing content-addressed generation is invalid: %v", ErrInvalidPackage, loadErr)
			}
			// A validated reinstall can repair a retired corrupt generation. Keep
			// the original directory for inspection rather than deleting its bytes.
			retiredDirectory := filepath.Join(manager.directory, report.Manifest.ID, "retired", generationID+"-"+stageID)
			if err := os.MkdirAll(filepath.Dir(retiredDirectory), 0o750); err != nil {
				return Generation{}, err
			}
			if err := os.Rename(finalDirectory, retiredDirectory); err != nil {
				return Generation{}, err
			}
			if err := os.Rename(stageDirectory, finalDirectory); err != nil {
				return Generation{}, errors.Join(err, os.Rename(retiredDirectory, finalDirectory))
			}
			stagePublished = true
		} else {
			if existing.Manifest.Version != report.Manifest.Version {
				return Generation{}, fmt.Errorf("%w: existing content-addressed generation has the wrong version", ErrInvalidPackage)
			}
			if err := manager.removeStage(stageDirectory); err != nil {
				return Generation{}, err
			}
			stagePublished = true
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return Generation{}, fmt.Errorf("inspect generation destination: %w", err)
	} else {
		if err := os.Rename(stageDirectory, finalDirectory); err != nil {
			return Generation{}, fmt.Errorf("publish package generation: %w", err)
		}
		stagePublished = true
	}
	return manager.store.recordGeneration(ctx, packageRecord{
		Manifest: report.Manifest, GenerationID: generationID, ArchiveSHA256: report.ArchiveSHA256,
	})
}

func (manager *Manager) Activate(ctx context.Context, plan ActivationPlan) (ActivationResult, error) {
	return manager.activate(ctx, plan, "activated")
}

// Rollback deliberately reuses normal activation. The target package is
// revalidated and restarted; files and database pointers are never swapped by
// an unverified shortcut.
func (manager *Manager) Rollback(ctx context.Context, plan ActivationPlan) (ActivationResult, error) {
	return manager.activate(ctx, plan, "rolled-back")
}

func (manager *Manager) activate(ctx context.Context, plan ActivationPlan, eventKind string) (ActivationResult, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	return manager.activateLocked(ctx, plan, eventKind, "")
}

func (manager *Manager) activateLocked(
	ctx context.Context,
	plan ActivationPlan,
	eventKind string,
	reviewID string,
) (ActivationResult, error) {
	state, generation, report, permissions, services, normalizedIDs, err := manager.prepareActivation(ctx, plan, true)
	if err != nil {
		return ActivationResult{}, err
	}
	plan.GrantedPermissionIDs = normalizedIDs
	previousID := state.ActiveGenerationID
	previous, hasPrevious := manager.runtimes[plan.AddonID]
	if previousID != "" && (!hasPrevious || previous.generation.GenerationID != previousID) {
		return ActivationResult{}, ErrRecoveryRequired
	}
	if previousID == plan.GenerationID && reflect.DeepEqual(state.GrantedPermissionIDs, plan.GrantedPermissionIDs) {
		return ActivationResult{State: state, Generation: generation, PreviousGenerationID: previousID}, nil
	}
	if dependents := manager.activationDependents(report.Manifest); len(dependents) != 0 {
		return ActivationResult{}, fmt.Errorf("%w: %s", ErrActivationCohort, strings.Join(dependents, ", "))
	}

	nextRuntime, err := manager.createRuntime(report, generation, permissions, services)
	if err != nil {
		_ = manager.store.recordFailure(ctx, plan.AddonID, plan.GenerationID, "activation-failed", err)
		return ActivationResult{}, fmt.Errorf("%w: %v", ErrActivationFailed, err)
	}
	if nextRuntime != nil {
		if err := nextRuntime.Start(ctx); err != nil {
			_ = manager.store.recordFailure(ctx, plan.AddonID, plan.GenerationID, "activation-failed", err)
			return ActivationResult{}, fmt.Errorf("%w: start runtime: %v", ErrActivationFailed, err)
		}
	}
	stopNext := true
	defer func() {
		if stopNext && nextRuntime != nil {
			_ = nextRuntime.Shutdown(context.Background())
		}
	}()
	dataTransition, err := manager.dataLifecycle.BeginActivation(
		ctx, plan.AddonID, plan.GenerationID, report.DataRegistry(),
	)
	if err != nil {
		_ = manager.store.recordFailure(ctx, plan.AddonID, plan.GenerationID, "activation-failed", err)
		return ActivationResult{}, fmt.Errorf("%w: prepare data generation: %v", ErrActivationFailed, err)
	}
	defer dataTransition.Rollback()
	catalogChanged, err := manager.publishServices(ctx, report, generation, nextRuntime, previousID)
	if err != nil {
		var rollbackErr error
		if catalogChanged {
			rollbackErr = manager.restoreServices(ctx, plan.AddonID, previous, hasPrevious, plan.GenerationID)
		}
		failure := errors.Join(err, rollbackErr)
		_ = manager.store.recordFailure(ctx, plan.AddonID, plan.GenerationID, "activation-failed", failure)
		return ActivationResult{}, fmt.Errorf("%w: publish services: %v", ErrActivationFailed, failure)
	}
	newState, err := manager.store.setActive(
		ctx, plan.AddonID, plan.GenerationID, plan.ExpectedStateRevision,
		plan.GrantedPermissionIDs, eventKind, reviewID,
	)
	if err != nil {
		rollbackErr := manager.restoreServices(ctx, plan.AddonID, previous, hasPrevious, plan.GenerationID)
		failure := errors.Join(err, rollbackErr)
		_ = manager.store.recordFailure(ctx, plan.AddonID, plan.GenerationID, "activation-failed", failure)
		return ActivationResult{}, failure
	}
	dataTransition.Commit()
	manager.runtimes[plan.AddonID] = activeRuntime{
		generation: generation, report: report, content: report.ContentRegistry(), runtime: nextRuntime,
		services: append([]servicebroker.Handle(nil), services...),
	}
	stopNext = false
	manager.workerReadyLocked(newState)
	manager.publishBrowserGraphChangeLocked(ctx, plan.AddonID, eventKind)

	result := ActivationResult{
		ReviewID: reviewID, State: newState, Generation: generation, PreviousGenerationID: previousID,
	}
	if hasPrevious && previous.runtime != nil {
		if err := previous.runtime.Shutdown(ctx); err != nil {
			result.CleanupError = err.Error()
			_ = manager.store.recordFailure(ctx, previous.generation.AddonID, previous.generation.GenerationID, "cleanup-failed", err)
		}
	}
	manager.cleanupAfterActivationLocked(ctx, &result)
	return result, nil
}

func (manager *Manager) liveDependents(providerAddonID string) []string {
	dependents := make([]string, 0)
	provider := manager.runtimes[providerAddonID]
	for addonID, active := range manager.runtimes {
		if addonID == providerAddonID {
			continue
		}
		dependent := false
		for _, dependency := range active.report.Manifest.Dependencies {
			if dependency.ID == providerAddonID && versionSatisfies(provider.generation.Version, dependency.Range) {
				dependent = true
				break
			}
		}
		if !dependent {
			for _, handle := range active.services {
				if handle.ProviderAddonID == providerAddonID {
					dependent = true
					break
				}
			}
		}
		if dependent {
			dependents = append(dependents, addonID)
		}
	}
	sort.Strings(dependents)
	return dependents
}

func (manager *Manager) Snapshot(ctx context.Context, addonID string, eventLimit int) (Snapshot, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	snapshot, err := manager.store.snapshot(ctx, addonID, eventLimit)
	if err != nil {
		return Snapshot{}, err
	}
	if active, exists := manager.runtimes[addonID]; exists && active.runtime != nil {
		runtimeSnapshot := active.runtime.Snapshot()
		snapshot.Runtime = &runtimeSnapshot
	} else if watch := manager.watchForStateLocked(snapshot.State); watch != nil && watch.blocked {
		identity := workersupervisor.Identity{AddonID: addonID, Generation: watch.generation}
		for _, generation := range snapshot.Generations {
			if generation.GenerationID == watch.generation {
				identity.Version = generation.Version
				break
			}
		}
		value := workersupervisor.Snapshot{Identity: identity}
		if watch.snapshot != nil {
			value = workersupervisor.AdministrativeSnapshot(*watch.snapshot)
		}
		value.State = workersupervisor.StateFailed
		value.LastError = watch.message
		snapshot.Runtime = &value
	}
	return snapshot, nil
}

// InstalledAddonIDs includes disabled and staged-only packages, unlike the active browser graph.
func (manager *Manager) InstalledAddonIDs(ctx context.Context) ([]string, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	return manager.store.installedAddonIDs(ctx)
}

func (manager *Manager) prepareActivation(
	ctx context.Context,
	plan ActivationPlan,
	requireRecoveredDependencies bool,
) (State, Generation, packageinspect.Report, []packageinspect.Permission, []servicebroker.Handle, []string, error) {
	state, err := manager.store.state(ctx, plan.AddonID)
	if err != nil {
		return State{}, Generation{}, packageinspect.Report{}, nil, nil, nil, err
	}
	if state.Revision != plan.ExpectedStateRevision || plan.GenerationID == "" {
		return State{}, Generation{}, packageinspect.Report{}, nil, nil, nil, ErrStaleActivationPlan
	}
	generation, err := manager.store.generation(ctx, plan.AddonID, plan.GenerationID)
	if err != nil {
		return State{}, Generation{}, packageinspect.Report{}, nil, nil, nil, err
	}
	report, err := manager.loadPackage(ctx, plan.AddonID, plan.GenerationID)
	if err != nil {
		return State{}, Generation{}, packageinspect.Report{}, nil, nil, nil, err
	}
	if err := manager.validateCompatibility(report.Manifest); err != nil {
		return State{}, Generation{}, packageinspect.Report{}, nil, nil, nil, err
	}
	if err := manager.validateRulesCompatibility(ctx, report.Manifest); err != nil {
		return State{}, Generation{}, packageinspect.Report{}, nil, nil, nil, err
	}
	if err := manager.validateRuleSources(ctx, report); err != nil {
		return State{}, Generation{}, packageinspect.Report{}, nil, nil, nil, err
	}
	if err := manager.validateDependencies(ctx, report.Manifest, requireRecoveredDependencies); err != nil {
		return State{}, Generation{}, packageinspect.Report{}, nil, nil, nil, err
	}
	permissions, normalizedIDs, err := approvedPermissions(report.Manifest.Permissions, plan.GrantedPermissionIDs)
	if err != nil {
		return State{}, Generation{}, packageinspect.Report{}, nil, nil, nil, err
	}
	services, err := manager.resolveServices(ctx, report.Manifest)
	if err != nil {
		return State{}, Generation{}, packageinspect.Report{}, nil, nil, nil, err
	}
	return state, generation, report, permissions, services, normalizedIDs, nil
}

func (manager *Manager) validateCompatibility(manifest packageinspect.Manifest) error {
	checks := []struct {
		name       string
		version    *semver.Version
		constraint string
	}{
		{"host", manager.hostVersion, manifest.Compatibility.Host},
		{"Add-on API", manager.addonAPIVersion, manifest.Compatibility.AddonAPI},
	}
	if manifest.Runtime != nil && manifest.Runtime.Worker != nil {
		checks = append(checks,
			struct {
				name       string
				version    *semver.Version
				constraint string
			}{"worker protocol compatibility", manager.workerProtocolVersion, manifest.Compatibility.WorkerProtocol},
			struct {
				name       string
				version    *semver.Version
				constraint string
			}{"worker protocol", manager.workerProtocolVersion, manifest.Runtime.Worker.Protocol},
		)
	}
	for _, check := range checks {
		constraint, err := semver.NewConstraint(check.constraint)
		if err != nil || !constraint.Check(check.version) {
			return fmt.Errorf("%w: %s %s does not satisfy %q", ErrCompatibility, check.name, check.version, check.constraint)
		}
	}
	for _, capability := range manifest.Capabilities.Required {
		if _, exists := manager.capabilities[capability]; !exists {
			return fmt.Errorf("%w: %s", ErrCapability, capability)
		}
	}
	return nil
}

func (manager *Manager) validateDependencies(
	ctx context.Context,
	manifest packageinspect.Manifest,
	requireRecovered bool,
) error {
	for _, dependency := range manifest.Dependencies {
		version, exists, err := manager.store.activeVersion(ctx, dependency.ID)
		if err != nil {
			return err
		}
		if !exists {
			if dependency.Required {
				return fmt.Errorf("%w: %s is not active", ErrDependency, dependency.ID)
			}
			continue
		}
		constraint, err := semver.NewConstraint(dependency.Range)
		parsed, parseErr := semver.StrictNewVersion(version)
		if err != nil || parseErr != nil || !constraint.Check(parsed) {
			if dependency.Required {
				return fmt.Errorf("%w: %s %s does not satisfy %q", ErrDependency, dependency.ID, version, dependency.Range)
			}
			continue
		}
		if requireRecovered && dependency.Required {
			if _, recovered := manager.runtimes[dependency.ID]; !recovered {
				return fmt.Errorf("%w: %s is not recovered", ErrDependency, dependency.ID)
			}
		}
	}
	return nil
}

func versionSatisfies(version, constraint string) bool {
	parsedVersion, versionErr := semver.StrictNewVersion(version)
	parsedConstraint, constraintErr := semver.NewConstraint(constraint)
	return versionErr == nil && constraintErr == nil && parsedConstraint.Check(parsedVersion)
}

func (manager *Manager) resolveServices(ctx context.Context, manifest packageinspect.Manifest) ([]servicebroker.Handle, error) {
	consumers := append([]packageinspect.ConsumedService(nil), manifest.Services.Consumes...)
	sort.Slice(consumers, func(left, right int) bool { return consumers[left].Contract < consumers[right].Contract })
	result := make([]servicebroker.Handle, 0)
	for _, consumer := range consumers {
		requirement := servicebroker.Requirement{
			ConsumerAddonID: manifest.ID,
			Contract:        consumer.Contract,
			Range:           consumer.Range,
			Cardinality:     servicebroker.Cardinality(consumer.Cardinality),
			Required:        consumer.Required,
			Selection:       servicebroker.Selection(consumer.Selection),
			Scope:           servicebroker.GlobalScope(),
		}
		if requirement.Cardinality == servicebroker.CardinalityOne {
			handle, err := manager.broker.ConnectOne(ctx, requirement)
			if err != nil {
				if !consumer.Required && optionalServiceError(err) {
					continue
				}
				return nil, fmt.Errorf("%w: %s: %v", ErrServiceResolution, consumer.Contract, err)
			}
			result = append(result, handle)
			continue
		}
		handles, err := manager.broker.ConnectMany(ctx, requirement)
		if err != nil {
			if !consumer.Required && optionalServiceError(err) {
				continue
			}
			return nil, fmt.Errorf("%w: %s: %v", ErrServiceResolution, consumer.Contract, err)
		}
		result = append(result, handles...)
	}
	return result, nil
}

func optionalServiceError(err error) bool {
	return errors.Is(err, servicebroker.ErrServiceUnavailable) ||
		errors.Is(err, servicebroker.ErrAmbiguousProvider) ||
		errors.Is(err, servicebroker.ErrInvalidSelection) ||
		errors.Is(err, servicebroker.ErrStaleBinding) ||
		errors.Is(err, servicebroker.ErrRuntimeUnavailable)
}

func approvedPermissions(
	requested []packageinspect.Permission,
	grantedIDs []string,
) ([]packageinspect.Permission, []string, error) {
	granted := append([]string(nil), grantedIDs...)
	sort.Strings(granted)
	for index, value := range granted {
		if value == "" || index > 0 && granted[index-1] == value {
			return nil, nil, fmt.Errorf("%w: duplicate or empty grant %q", ErrPermission, value)
		}
	}
	requestedByID := make(map[string]packageinspect.Permission, len(requested))
	for _, permission := range requested {
		requestedByID[permission.ID] = permission
	}
	result := make([]packageinspect.Permission, 0, len(granted))
	for _, id := range granted {
		permission, exists := requestedByID[id]
		if !exists {
			return nil, nil, fmt.Errorf("%w: unrequested permission %s", ErrPermission, id)
		}
		result = append(result, permission)
	}
	for _, permission := range requested {
		if permission.Optional {
			continue
		}
		index := sort.SearchStrings(granted, permission.ID)
		if index == len(granted) || granted[index] != permission.ID {
			return nil, nil, fmt.Errorf("%w: required permission %s was not granted", ErrPermission, permission.ID)
		}
	}
	return result, granted, nil
}

func (manager *Manager) createRuntime(
	report packageinspect.Report,
	generation Generation,
	permissions []packageinspect.Permission,
	services []servicebroker.Handle,
) (Runtime, error) {
	if report.Manifest.Runtime == nil || report.Manifest.Runtime.Worker == nil {
		return nil, nil
	}
	if manager.runtimeFactory == nil {
		return nil, ErrRuntimeUnsupported
	}
	runtime, err := manager.runtimeFactory.New(RuntimeSpec{
		Identity: workersupervisor.Identity{
			AddonID: report.Manifest.ID, Version: report.Manifest.Version, Generation: generation.GenerationID,
		},
		RootDirectory:      filepath.Join(manager.generationDirectory(generation.AddonID, generation.GenerationID), "root"),
		Manifest:           report.Manifest,
		GrantedPermissions: append([]packageinspect.Permission(nil), permissions...),
		BoundServices:      append([]servicebroker.Handle(nil), services...),
		ServiceContracts:   report.ServiceRegistry().Descriptions(),
	})
	if err != nil {
		return nil, err
	}
	if runtime == nil {
		return nil, fmt.Errorf("%w: runtime factory returned nil", ErrRuntimeUnsupported)
	}
	return runtime, nil
}

func (manager *Manager) publishServices(
	ctx context.Context,
	report packageinspect.Report,
	generation Generation,
	runtime Runtime,
	previousGenerationID string,
) (bool, error) {
	declarations := providerDeclarations(report)
	if err := manager.broker.ReplaceProviders(ctx, report.Manifest.ID, report.Manifest.Version, declarations); err != nil {
		return false, err
	}
	if len(declarations) == 0 {
		if previousGenerationID != "" {
			manager.broker.DeactivateRuntime(report.Manifest.ID, previousGenerationID)
		}
		return true, nil
	}
	adapters, err := manager.serviceRuntimeAdapters(ctx, report, runtime)
	if err != nil {
		return true, err
	}
	return true, manager.broker.ActivateRuntimeWithAdapters(
		ctx, report.Manifest.ID, generation.GenerationID, report.ServiceRegistry(), adapters,
	)
}

func (manager *Manager) activatePublishedServices(
	ctx context.Context,
	report packageinspect.Report,
	generation Generation,
	runtime Runtime,
) error {
	if len(report.Manifest.Services.Provides) == 0 {
		return nil
	}
	adapters, err := manager.serviceRuntimeAdapters(ctx, report, runtime)
	if err != nil {
		return err
	}
	return manager.broker.ActivateRuntimeWithAdapters(
		ctx, report.Manifest.ID, generation.GenerationID, report.ServiceRegistry(), adapters,
	)
}

func (manager *Manager) serviceRuntimeAdapters(
	ctx context.Context,
	report packageinspect.Report,
	runtime Runtime,
) (servicebroker.RuntimeAdapters, error) {
	adapters := servicebroker.RuntimeAdapters{Worker: runtime}
	for _, provider := range report.Manifest.Services.Provides {
		if provider.Transport != string(servicebroker.TransportContent) {
			continue
		}
		content, err := manager.effectiveContent(ctx, report)
		if err != nil {
			return servicebroker.RuntimeAdapters{}, err
		}
		caller, err := contenttransport.New(content)
		if err != nil {
			return servicebroker.RuntimeAdapters{}, fmt.Errorf("configure content service: %w", err)
		}
		adapters.Content = caller
		break
	}
	return adapters, nil
}

func providerDeclarations(report packageinspect.Report) []servicebroker.ProviderDeclaration {
	result := make([]servicebroker.ProviderDeclaration, 0, len(report.Manifest.Services.Provides))
	for _, provider := range report.Manifest.Services.Provides {
		result = append(result, servicebroker.ProviderDeclaration{
			Contract: provider.Contract, Version: provider.Version,
			Transport: servicebroker.Transport(provider.Transport), Schema: provider.Schema,
			Exclusive: provider.Exclusive,
		})
	}
	return result
}

func (manager *Manager) restoreServices(
	ctx context.Context,
	addonID string,
	previous activeRuntime,
	hasPrevious bool,
	failedGenerationID string,
) error {
	manager.broker.DeactivateRuntime(addonID, failedGenerationID)
	if !hasPrevious {
		return manager.broker.RemoveProviders(ctx, addonID)
	}
	declarations := providerDeclarations(previous.report)
	if err := manager.broker.ReplaceProviders(ctx, addonID, previous.generation.Version, declarations); err != nil {
		return err
	}
	if len(declarations) == 0 {
		return nil
	}
	adapters, err := manager.serviceRuntimeAdapters(ctx, previous.report, previous.runtime)
	if err != nil {
		return err
	}
	return manager.broker.ActivateRuntimeWithAdapters(
		ctx, addonID, previous.generation.GenerationID,
		previous.report.ServiceRegistry(), adapters,
	)
}

func (manager *Manager) loadPackage(ctx context.Context, addonID, generationID string) (packageinspect.Report, error) {
	if !validAddonPath(addonID) || !validGenerationID(generationID) {
		return packageinspect.Report{}, ErrGenerationNotFound
	}
	archive := filepath.Join(manager.generationDirectory(addonID, generationID), "package.zip")
	report, err := manager.inspector.InspectFile(ctx, archive)
	if err != nil {
		return packageinspect.Report{}, fmt.Errorf("%w: %v", ErrInvalidPackage, err)
	}
	if report.Manifest.ID != addonID || report.ArchiveSHA256 != generationID {
		return packageinspect.Report{}, fmt.Errorf("%w: generation identity does not match archive", ErrInvalidPackage)
	}
	root := filepath.Join(manager.generationDirectory(addonID, generationID), "root")
	if info, err := os.Stat(root); err != nil || !info.IsDir() {
		return packageinspect.Report{}, fmt.Errorf("%w: extracted package root is unavailable", ErrInvalidPackage)
	}
	if err := manager.inspector.VerifyExtracted(ctx, root, report); err != nil {
		return packageinspect.Report{}, fmt.Errorf("%w: extracted generation verification failed: %v", ErrInvalidPackage, err)
	}
	return report, nil
}

func (manager *Manager) generationDirectory(addonID, generationID string) string {
	return filepath.Join(manager.directory, addonID, "generations", generationID)
}

func (manager *Manager) removeStage(stageDirectory string) error {
	relative, err := filepath.Rel(manager.stagingDirectory, stageDirectory)
	if err != nil || relative == "." || relative == ".." || filepath.IsAbs(relative) || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return fmt.Errorf("refuse to remove package stage outside staging directory")
	}
	if err := os.RemoveAll(stageDirectory); err != nil {
		return fmt.Errorf("remove package stage: %w", err)
	}
	return nil
}

func copyBoundedArchive(ctx context.Context, input io.Reader, destination string, maximum int64) error {
	output, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o640)
	if err != nil {
		return fmt.Errorf("create staged package: %w", err)
	}
	reader := &contextReader{ctx: ctx, reader: io.LimitReader(input, maximum+1)}
	written, copyErr := io.Copy(output, reader)
	if copyErr == nil && written > maximum {
		copyErr = fmt.Errorf("package source exceeds %d bytes", maximum)
	}
	if copyErr == nil {
		copyErr = output.Sync()
	}
	closeErr := output.Close()
	if copyErr != nil {
		return fmt.Errorf("copy staged package: %w", copyErr)
	}
	if closeErr != nil {
		return fmt.Errorf("close staged package: %w", closeErr)
	}
	return nil
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (reader *contextReader) Read(buffer []byte) (int, error) {
	if err := reader.ctx.Err(); err != nil {
		return 0, err
	}
	return reader.reader.Read(buffer)
}

func validStageID(value string) bool {
	if len(value) < 16 || len(value) > 100 {
		return false
	}
	for _, character := range value {
		if character < 'a' || character > 'z' {
			if character < '0' || character > '9' {
				return false
			}
		}
	}
	return true
}

func validAddonPath(value string) bool {
	return len(value) <= 80 && addonIDPattern.MatchString(value)
}

func validGenerationID(value string) bool {
	if len(value) != 64 {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil && value == strings.ToLower(value)
}

func randomID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(value[:]), nil
}
