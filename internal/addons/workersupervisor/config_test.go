package workersupervisor

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestNormalizeConfigRejectsUnsafeLaunchConfiguration(t *testing.T) {
	t.Parallel()

	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	base := validTestConfig(t, "healthy")
	tests := []struct {
		name   string
		mutate func(*Config)
	}{
		{"missing executable", func(config *Config) { config.Executable = "" }},
		{"directory executable", func(config *Config) { config.Executable = t.TempDir() }},
		{"missing working directory", func(config *Config) { config.WorkingDirectory = "" }},
		{"file working directory", func(config *Config) { config.WorkingDirectory = executable }},
		{"invalid environment name", func(config *Config) { config.Environment["BAD=NAME"] = "value" }},
		{"case-colliding environment", func(config *Config) {
			config.Environment["PATH"] = "one"
			config.Environment["Path"] = "two"
		}},
		{"null environment value", func(config *Config) { config.Environment["BAD"] = "a\x00b" }},
		{"null argument", func(config *Config) { config.Arguments = append(config.Arguments, "a\x00b") }},
		{"non-JSON grant", func(config *Config) { config.Grants = []any{make(chan int)} }},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			config := base
			config.Environment = cloneMap(base.Environment)
			test.mutate(&config)
			if _, err := New(config); err == nil {
				t.Fatal("New succeeded")
			}
		})
	}

	if !filepath.IsAbs(base.Executable) {
		t.Fatalf("test executable is not absolute: %s", base.Executable)
	}
}

func TestNewSnapshotsMutableConfiguration(t *testing.T) {
	t.Parallel()

	config := validTestConfig(t, "healthy")
	config.Grants = []any{map[string]any{"id": "data.read"}}
	config.Services = []any{map[string]any{"id": "rules", "version": "2.0.0"}}
	supervisor, err := New(config)
	if err != nil {
		t.Fatal(err)
	}

	config.Arguments[0] = "changed"
	config.Environment[helperProcessEnvironment] = "changed"
	config.Grants[0].(map[string]any)["id"] = "changed"
	config.Services[0].(map[string]any)["id"] = "changed"

	if supervisor.config.Arguments[0] == "changed" {
		t.Fatal("worker arguments retained caller-owned storage")
	}
	if supervisor.environment[0] == helperProcessEnvironment+"=changed" {
		t.Fatal("worker environment retained caller-owned storage")
	}
	params := supervisor.initializeParams()
	if params["grants"].([]any)[0].(map[string]any)["id"] != "data.read" {
		t.Fatal("worker grants retained caller-owned storage")
	}
	if params["services"].([]any)[0].(map[string]any)["id"] != "rules" {
		t.Fatal("worker services retained caller-owned storage")
	}
}

func TestStartHonorsAlreadyCancelledContext(t *testing.T) {
	t.Parallel()

	supervisor := newTestSupervisor(t, "healthy", nil)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := supervisor.Start(ctx); err != context.Canceled {
		t.Fatalf("Start error = %v, want context.Canceled", err)
	}
	if snapshot := supervisor.Snapshot(); snapshot.State != StateCreated || len(snapshot.Transitions) != 0 {
		t.Fatalf("cancelled start changed supervisor: %+v", snapshot)
	}
}
