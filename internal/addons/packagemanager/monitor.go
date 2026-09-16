package packagemanager

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/addons/workersupervisor"
)

// MonitoringConfig bounds coordinator-owned health checks and recovery. Nil in
// Config disables background monitoring for offline tools and embedded callers.
type MonitoringConfig struct {
	PollInterval      time.Duration
	HealthInterval    time.Duration
	HealthTimeout     time.Duration
	TransitionTimeout time.Duration
	RestartPolicy     workersupervisor.RestartPolicy
}
type workerHealthRuntime interface {
	Health(context.Context) (workersupervisor.Health, error)
}
type workerWatch struct {
	generation    string
	stateRevision int64
	failures      int
	blocked       bool
	retryAt       time.Time
	readySince    time.Time
	nextHealth    time.Time
	message       string
	snapshot      *workersupervisor.Snapshot
}
type workerMonitor struct {
	config   MonitoringConfig
	session  string
	revision uint64
	watches  map[string]*workerWatch
}

func newWorkerMonitor(config *MonitoringConfig) (*workerMonitor, error) {
	if config == nil {
		return nil, nil
	}
	normalized := *config
	if normalized.PollInterval <= 0 {
		normalized.PollInterval = time.Second
	}
	if normalized.HealthInterval <= 0 {
		normalized.HealthInterval = 30 * time.Second
	}
	if normalized.HealthTimeout <= 0 {
		normalized.HealthTimeout = 5 * time.Second
	}
	if normalized.TransitionTimeout <= 0 {
		normalized.TransitionTimeout = 2 * time.Minute
	}
	if normalized.RestartPolicy.StableAfter <= 0 {
		normalized.RestartPolicy.StableAfter = workersupervisor.DefaultRestartPolicy.StableAfter
	}
	session, err := randomID()
	if err != nil {
		return nil, err
	}
	return &workerMonitor{config: normalized, session: session, watches: map[string]*workerWatch{}}, nil
}

// StartMonitoring is called once the host is composed. Shutdown cancels and
// joins this loop before withdrawing workers, so a timer cannot resurrect them.
func (manager *Manager) StartMonitoring(ctx context.Context) {
	manager.monitorMu.Lock()
	defer manager.monitorMu.Unlock()
	if manager.monitoring == nil || manager.monitorCancel != nil {
		return
	}
	monitorCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	manager.monitorCancel, manager.monitorDone = cancel, done
	go func() {
		defer close(done)
		ticker := time.NewTicker(manager.monitoring.config.PollInterval)
		defer ticker.Stop()
		for {
			select {
			case <-monitorCtx.Done():
				return
			case <-ticker.C:
				if err := manager.checkWorkers(monitorCtx); err != nil && monitorCtx.Err() == nil {
					manager.logger.Error("monitor add-on workers", "error", err)
				}
			}
		}
	}()
}
func (manager *Manager) stopMonitoring() {
	manager.monitorMu.Lock()
	defer manager.monitorMu.Unlock()
	if manager.monitorCancel != nil {
		manager.monitorCancel()
		<-manager.monitorDone
		manager.monitorCancel, manager.monitorDone = nil, nil
	}
}

func (manager *Manager) watchForStateLocked(state State) *workerWatch {
	if manager.monitoring == nil {
		return nil
	}
	watch := manager.monitoring.watches[state.AddonID]
	if watch != nil && (watch.generation != state.ActiveGenerationID || watch.stateRevision != state.Revision) {
		delete(manager.monitoring.watches, state.AddonID)
		return nil
	}
	return watch
}
func (manager *Manager) workerReadyLocked(state State) {
	if manager.monitoring == nil {
		return
	}
	watch := manager.watchForStateLocked(state)
	if watch == nil {
		watch = &workerWatch{generation: state.ActiveGenerationID, stateRevision: state.Revision}
		manager.monitoring.watches[state.AddonID] = watch
	}
	now := manager.store.now()
	watch.blocked, watch.retryAt, watch.message = false, time.Time{}, ""
	watch.readySince, watch.nextHealth = now, now.Add(manager.monitoring.config.HealthInterval)
}
func (manager *Manager) workerFailureLocked(ctx context.Context, state State, cause error) {
	if manager.monitoring == nil {
		return
	}
	watch := manager.watchForStateLocked(state)
	if watch == nil {
		watch = &workerWatch{generation: state.ActiveGenerationID, stateRevision: state.Revision}
		manager.monitoring.watches[state.AddonID] = watch
	}
	now := manager.store.now()
	if !watch.readySince.IsZero() && now.Sub(watch.readySince) >= manager.monitoring.config.RestartPolicy.StableAfter {
		watch.failures = 0
	}
	if active, ok := manager.runtimes[state.AddonID]; ok && active.runtime != nil {
		value := workersupervisor.AdministrativeSnapshot(active.runtime.Snapshot())
		watch.snapshot = &value
	}
	watch.failures++
	watch.blocked, watch.readySince, watch.retryAt = true, time.Time{}, time.Time{}
	decision := manager.monitoring.config.RestartPolicy.Decide(watch.failures)
	code := workersupervisor.CodeProcessExited
	var lifecycle *workersupervisor.LifecycleError
	if errors.As(cause, &lifecycle) {
		switch lifecycle.Code {
		case workersupervisor.CodeSpawnFailed, workersupervisor.CodeStartupFailed, workersupervisor.CodeStartupTimed,
			workersupervisor.CodeHealthFailed, workersupervisor.CodeProcessExited, workersupervisor.CodeTransportFailed:
			code = lifecycle.Code
		}
	}
	// Health details and raw worker output are not an administrative diagnostic API.
	watch.message = code + ": worker unavailable; automatic recovery paused. Use Reload to retry."
	if decision.Allowed {
		watch.retryAt = now.Add(decision.Delay)
		watch.message = fmt.Sprintf("%s: worker unavailable; recovery attempt %d scheduled.", code, watch.failures)
	}
	if err := manager.store.recordFailure(ctx, state.AddonID, state.ActiveGenerationID, "worker-unavailable", errors.New(watch.message)); err != nil {
		manager.logger.Error("record worker availability", "addonId", state.AddonID, "error", err)
	}
}
func (manager *Manager) workerDeferredLocked(state State) bool {
	watch := manager.watchForStateLocked(state)
	return watch != nil && watch.blocked && (watch.retryAt.IsZero() || manager.store.now().Before(watch.retryAt))
}
func (manager *Manager) monitoringRevisionLocked() string {
	if manager.monitoring == nil {
		return ""
	}
	return manager.monitoring.session + ":" + strconv.FormatUint(manager.monitoring.revision, 10)
}

// A failed provider invalidates its transitive live consumers, including optional
// consumers that hold old handles. Unrelated runtimes do not need to stop.
func (manager *Manager) workerCohortLocked(ctx context.Context, roots []string) (map[string]bool, error) {
	cohort := map[string]bool{}
	var visit func(string) error
	visit = func(id string) error {
		if cohort[id] {
			return nil
		}
		cohort[id] = true
		active, live := manager.runtimes[id]
		manifest := active.report.Manifest
		if !live {
			state, err := manager.store.state(ctx, id)
			if err != nil {
				return err
			}
			manifest, err = manager.store.manifest(ctx, id, state.ActiveGenerationID)
			if err != nil {
				return err
			}
		}
		// Degraded optional consumers no longer hold a service handle. Include
		// their declared contracts so they reconnect when the provider returns.
		for _, dependent := range manager.activationDependents(manifest) {
			if err := visit(dependent); err != nil {
				return err
			}
		}
		return nil
	}
	for _, root := range roots {
		if err := visit(root); err != nil {
			return nil, err
		}
	}
	return cohort, nil
}
func (manager *Manager) checkWorkers(ctx context.Context) error {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if manager.monitoring == nil || ctx.Err() != nil {
		return ctx.Err()
	}
	states, err := manager.store.activeStates(ctx)
	if err != nil {
		return err
	}
	activeStates := map[string]State{}
	for _, state := range states {
		activeStates[state.AddonID] = state
	}
	for id := range manager.monitoring.watches {
		state, active := activeStates[id]
		if !active {
			delete(manager.monitoring.watches, id)
		} else {
			manager.watchForStateLocked(state)
		}
	}
	now := manager.store.now()
	roots := []string{}
	for _, state := range states {
		active, live := manager.runtimes[state.AddonID]
		watch := manager.watchForStateLocked(state)
		if !live {
			if watch != nil && watch.blocked && !watch.retryAt.IsZero() && !now.Before(watch.retryAt) {
				roots = append(roots, state.AddonID)
			}
			continue
		}
		if active.runtime == nil {
			continue
		}
		if watch == nil {
			manager.workerReadyLocked(state)
			watch = manager.watchForStateLocked(state)
		}
		var failure error
		snapshot := active.runtime.Snapshot()
		if snapshot.State != workersupervisor.StateReady {
			failure = &workersupervisor.LifecycleError{Code: workersupervisor.CodeProcessExited}
		} else if healthRuntime, ok := active.runtime.(workerHealthRuntime); ok && !now.Before(watch.nextHealth) {
			healthCtx, cancel := context.WithTimeout(ctx, manager.monitoring.config.HealthTimeout)
			health, healthErr := healthRuntime.Health(healthCtx)
			cancel()
			if ctx.Err() != nil {
				return ctx.Err()
			}
			watch.nextHealth = now.Add(manager.monitoring.config.HealthInterval)
			if healthErr != nil || (health.Status != "ok" && health.Status != "degraded") {
				failure = &workersupervisor.LifecycleError{Code: workersupervisor.CodeHealthFailed, Cause: healthErr}
			} else if health.Status == "degraded" {
				watch.readySince = time.Time{}
			} else if watch.readySince.IsZero() {
				watch.readySince = now
			}
		}
		if failure != nil {
			manager.workerFailureLocked(ctx, state, failure)
			roots = append(roots, state.AddonID)
		} else if !watch.readySince.IsZero() && now.Sub(watch.readySince) >= manager.monitoring.config.RestartPolicy.StableAfter {
			watch.failures = 0
		}
	}
	if len(roots) == 0 {
		return nil
	}
	transitionCtx, cancel := context.WithTimeout(ctx, manager.monitoring.config.TransitionTimeout)
	defer cancel()
	return manager.recoverWorkerCohortLocked(transitionCtx, roots)
}
func (manager *Manager) recoverWorkerCohortLocked(ctx context.Context, roots []string) error {
	sort.Strings(roots)
	cohort, err := manager.workerCohortLocked(ctx, roots)
	if err != nil {
		return err
	}
	stopErr := manager.shutdownSubsetLocked(ctx, cohort)
	manager.monitoring.revision++
	// Publish withdrawal before restart so connected browsers dispose stale handles.
	manager.publishBrowserGraphChangeLocked(ctx, "", "worker-unavailable")
	if ctx.Err() != nil {
		return errors.Join(stopErr, ctx.Err())
	}
	_, recoverErr := manager.recoverMissingLocked(ctx)
	manager.monitoring.revision++
	manager.publishBrowserGraphChangeLocked(ctx, "", "worker-recovery")
	return errors.Join(stopErr, recoverErr)
}

func (manager *Manager) reloadUnavailableWorkerLocked(ctx context.Context, state State) (ActivationResult, error) {
	watch := manager.watchForStateLocked(state)
	if watch == nil || !watch.blocked {
		return ActivationResult{}, ErrRecoveryRequired
	}
	// Only an explicit, revision-checked operator action resets an exhausted budget.
	delete(manager.monitoring.watches, state.AddonID)
	transitionCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), manager.monitoring.config.TransitionTimeout)
	defer cancel()
	err := manager.recoverWorkerCohortLocked(transitionCtx, []string{state.AddonID})
	active, recovered := manager.runtimes[state.AddonID]
	if !recovered {
		return ActivationResult{}, errors.Join(ErrRecoveryRequired, err)
	}
	newState, stateErr := manager.store.setActive(transitionCtx, state.AddonID, state.ActiveGenerationID, state.Revision, state.GrantedPermissionIDs, "reloaded", "")
	if stateErr != nil {
		return ActivationResult{}, errors.Join(stateErr, err)
	}
	manager.workerReadyLocked(newState)
	manager.publishBrowserGraphChangeLocked(transitionCtx, state.AddonID, "reloaded")
	result := ActivationResult{State: newState, Generation: active.generation, PreviousGenerationID: state.ActiveGenerationID}
	if err != nil {
		result.CleanupError = err.Error()
	}
	return result, nil
}
