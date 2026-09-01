package packagemanager

import (
	"fmt"
	"log/slog"
	"path/filepath"
	"runtime"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/addons/workersupervisor"
	"github.com/pjunak/ttrpg-codex/sdk/go/workerrpc"
)

type SupervisorFactoryConfig struct {
	Host            workersupervisor.HostInfo
	ProtocolVersion string
	Target          string
	Environment     map[string]string
	Limits          workersupervisor.WorkerLimits
	StartupTimeout  time.Duration
	HealthTimeout   time.Duration
	ShutdownTimeout time.Duration
	MaxStderrBytes  int
	Logger          *slog.Logger
	HandlerFactory  WorkerHandlerFactory
}

type WorkerHandlerFactory interface {
	HandlerFor(RuntimeSpec) (workerrpc.RequestHandler, error)
}

type WorkerHandlerFactoryFunc func(RuntimeSpec) (workerrpc.RequestHandler, error)

func (factory WorkerHandlerFactoryFunc) HandlerFor(spec RuntimeSpec) (workerrpc.RequestHandler, error) {
	return factory(spec)
}

type SupervisorFactory struct {
	config SupervisorFactoryConfig
}

func NewSupervisorFactory(config SupervisorFactoryConfig) (*SupervisorFactory, error) {
	if config.Host.Version == "" || config.Host.Locale == "" || config.Host.TimeZone == "" ||
		config.ProtocolVersion == "" || config.HandlerFactory == nil {
		return nil, fmt.Errorf("%w: supervisor host, protocol, and handler are required", ErrInvalidConfig)
	}
	if config.Target == "" {
		config.Target = runtime.GOOS + "-" + runtime.GOARCH
	}
	if config.Logger == nil {
		config.Logger = slog.Default()
	}
	config.Environment = cloneStrings(config.Environment)
	return &SupervisorFactory{config: config}, nil
}

func (factory *SupervisorFactory) New(spec RuntimeSpec) (Runtime, error) {
	if factory == nil {
		return nil, fmt.Errorf("%w: supervisor factory is required", ErrInvalidConfig)
	}
	if spec.Manifest.Runtime == nil || spec.Manifest.Runtime.Worker == nil {
		return nil, fmt.Errorf("%w: package has no worker runtime", ErrRuntimeUnsupported)
	}
	worker := spec.Manifest.Runtime.Worker
	if worker.Type != "native" {
		return nil, fmt.Errorf("%w: %s worker", ErrRuntimeUnsupported, worker.Type)
	}
	entrypoint, exists := worker.Entrypoints[factory.config.Target]
	if !exists {
		return nil, fmt.Errorf("%w: package has no worker for %s", ErrRuntimeUnsupported, factory.config.Target)
	}
	executable := filepath.Join(spec.RootDirectory, filepath.FromSlash(entrypoint))
	handler, err := factory.config.HandlerFactory.HandlerFor(spec)
	if err != nil {
		return nil, fmt.Errorf("configure worker host methods: %w", err)
	}
	if handler == nil {
		return nil, fmt.Errorf("%w: worker handler factory returned nil", ErrInvalidConfig)
	}
	grants := make([]any, len(spec.GrantedPermissions))
	for index, permission := range spec.GrantedPermissions {
		grants[index] = permission
	}
	services := make([]any, len(spec.BoundServices))
	for index, service := range spec.BoundServices {
		services[index] = service
	}
	return workersupervisor.New(workersupervisor.Config{
		Identity:         spec.Identity,
		Host:             factory.config.Host,
		ProtocolVersion:  factory.config.ProtocolVersion,
		Executable:       executable,
		WorkingDirectory: spec.RootDirectory,
		Environment:      cloneStrings(factory.config.Environment),
		Grants:           grants,
		Services:         services,
		Limits:           factory.config.Limits,
		StartupTimeout:   factory.config.StartupTimeout,
		HealthTimeout:    factory.config.HealthTimeout,
		ShutdownTimeout:  factory.config.ShutdownTimeout,
		MaxStderrBytes:   factory.config.MaxStderrBytes,
		Logger:           factory.config.Logger,
		Handler:          handler,
	})
}

func cloneStrings(values map[string]string) map[string]string {
	result := make(map[string]string, len(values))
	for key, value := range values {
		result[key] = value
	}
	return result
}

var _ RuntimeFactory = (*SupervisorFactory)(nil)
