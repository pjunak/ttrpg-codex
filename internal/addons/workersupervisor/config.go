package workersupervisor

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/pjunak/ttrpg-codex/sdk/go/workerrpc"
)

var environmentNamePattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

type Identity struct {
	AddonID    string `json:"id"`
	Version    string `json:"version"`
	Generation string `json:"generation"`
}

type HostInfo struct {
	Version  string `json:"version"`
	Locale   string `json:"locale"`
	TimeZone string `json:"timeZone"`
}

type WorkerLimits struct {
	MaxFrameBytes         int `json:"maxFrameBytes"`
	MaxConcurrentRequests int `json:"maxConcurrentRequests"`
	DefaultDeadlineMS     int `json:"defaultDeadlineMs"`
}

type Config struct {
	Identity         Identity
	Host             HostInfo
	ProtocolVersion  string
	Executable       string
	Arguments        []string
	WorkingDirectory string
	Environment      map[string]string
	Grants           []any
	Services         []any
	Limits           WorkerLimits
	StartupTimeout   time.Duration
	HealthTimeout    time.Duration
	ShutdownTimeout  time.Duration
	MaxStderrBytes   int
	Logger           *slog.Logger
}

func normalizeConfig(config Config) (Config, []string, error) {
	if config.Identity.AddonID == "" || config.Identity.Version == "" || config.Identity.Generation == "" {
		return Config{}, nil, fmt.Errorf("worker add-on id, version, and generation are required")
	}
	if config.Host.Version == "" || config.Host.Locale == "" || config.Host.TimeZone == "" {
		return Config{}, nil, fmt.Errorf("host version, locale, and time zone are required")
	}
	if config.ProtocolVersion == "" {
		config.ProtocolVersion = "1.0.0"
	}

	if config.Executable == "" {
		return Config{}, nil, fmt.Errorf("worker executable is required")
	}
	executable, err := filepath.Abs(config.Executable)
	if err != nil {
		return Config{}, nil, fmt.Errorf("resolve worker executable: %w", err)
	}
	info, err := os.Stat(executable)
	if err != nil {
		return Config{}, nil, fmt.Errorf("stat worker executable: %w", err)
	}
	if info.IsDir() || !info.Mode().IsRegular() {
		return Config{}, nil, fmt.Errorf("worker executable is not a regular file")
	}
	config.Executable = executable

	if config.WorkingDirectory == "" {
		return Config{}, nil, fmt.Errorf("worker directory is required")
	}
	workingDirectory, err := filepath.Abs(config.WorkingDirectory)
	if err != nil {
		return Config{}, nil, fmt.Errorf("resolve worker directory: %w", err)
	}
	info, err = os.Stat(workingDirectory)
	if err != nil {
		return Config{}, nil, fmt.Errorf("stat worker directory: %w", err)
	}
	if !info.IsDir() {
		return Config{}, nil, fmt.Errorf("worker directory is not a directory")
	}
	config.WorkingDirectory = workingDirectory

	if config.Limits.MaxFrameBytes <= 0 {
		config.Limits.MaxFrameBytes = workerrpc.DefaultLimits.MaxFrameBytes
	}
	if config.Limits.MaxConcurrentRequests <= 0 {
		config.Limits.MaxConcurrentRequests = 16
	}
	if config.Limits.DefaultDeadlineMS <= 0 {
		config.Limits.DefaultDeadlineMS = 5_000
	}
	if config.StartupTimeout <= 0 {
		config.StartupTimeout = 10 * time.Second
	}
	if config.HealthTimeout <= 0 {
		config.HealthTimeout = 3 * time.Second
	}
	if config.ShutdownTimeout <= 0 {
		config.ShutdownTimeout = 5 * time.Second
	}
	if config.MaxStderrBytes <= 0 {
		config.MaxStderrBytes = 64 << 10
	}
	if config.Logger == nil {
		config.Logger = slog.Default()
	}

	environment, err := buildEnvironment(config.Environment)
	if err != nil {
		return Config{}, nil, err
	}
	config.Arguments = append([]string(nil), config.Arguments...)
	for _, argument := range config.Arguments {
		if strings.IndexByte(argument, 0) >= 0 {
			return Config{}, nil, fmt.Errorf("worker argument contains a null byte")
		}
	}
	config.Grants, err = cloneJSONList("worker grants", config.Grants)
	if err != nil {
		return Config{}, nil, err
	}
	config.Services, err = cloneJSONList("worker services", config.Services)
	if err != nil {
		return Config{}, nil, err
	}
	return config, environment, nil
}

func cloneJSONList(name string, values []any) ([]any, error) {
	if values == nil {
		return []any{}, nil
	}
	body, err := json.Marshal(values)
	if err != nil {
		return nil, fmt.Errorf("encode %s: %w", name, err)
	}
	var cloned []any
	if err := json.Unmarshal(body, &cloned); err != nil {
		return nil, fmt.Errorf("decode %s: %w", name, err)
	}
	return cloned, nil
}

func buildEnvironment(values map[string]string) ([]string, error) {
	keys := make([]string, 0, len(values))
	folded := make(map[string]string, len(values))
	for key, value := range values {
		if !environmentNamePattern.MatchString(key) {
			return nil, fmt.Errorf("invalid worker environment name %q", key)
		}
		if strings.IndexByte(value, 0) >= 0 {
			return nil, fmt.Errorf("worker environment %q contains a null byte", key)
		}
		canonical := strings.ToUpper(key)
		if previous, exists := folded[canonical]; exists {
			return nil, fmt.Errorf("worker environment names %q and %q collide", previous, key)
		}
		folded[canonical] = key
		keys = append(keys, key)
	}
	sort.Strings(keys)
	environment := make([]string, 0, len(keys))
	for _, key := range keys {
		environment = append(environment, key+"="+values[key])
	}
	return environment, nil
}
