package packagemanager

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/pjunak/ttrpg-codex/internal/addons/packageinspect"
	"github.com/pjunak/ttrpg-codex/internal/addons/workersupervisor"
	"github.com/pjunak/ttrpg-codex/sdk/go/workerrpc"
)

func TestSupervisorFactorySelectsExactNativeTarget(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	executable := filepath.Join(root, "worker", "windows-amd64", "addon.exe")
	if err := os.MkdirAll(filepath.Dir(executable), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(executable, []byte("worker"), 0o750); err != nil {
		t.Fatal(err)
	}
	factory, err := NewSupervisorFactory(SupervisorFactoryConfig{
		Host: workersupervisor.HostInfo{
			Version: "2.0.0", Locale: "en", TimeZone: "Europe/Prague",
		},
		ProtocolVersion: "1.0.0",
		Target:          "windows-amd64",
		Handler: workerrpc.RequestHandlerFunc(func(context.Context, workerrpc.Request) (any, error) {
			return nil, nil
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	identity := workersupervisor.Identity{
		AddonID: "engine-addon", Version: "1.0.0", Generation: "generation-1",
	}
	runtime, err := factory.New(RuntimeSpec{
		Identity:      identity,
		RootDirectory: root,
		Manifest: packageinspect.Manifest{Runtime: &packageinspect.Runtime{
			Worker: &packageinspect.WorkerRuntime{
				Type: "native", Entrypoints: map[string]string{
					"windows-amd64": "worker/windows-amd64/addon.exe",
				},
			},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if snapshot := runtime.Snapshot(); snapshot.Identity != identity || snapshot.State != workersupervisor.StateCreated {
		t.Fatalf("factory runtime snapshot = %+v", snapshot)
	}
}

func TestSupervisorFactoryRejectsUnsupportedWorkerProfileAndTarget(t *testing.T) {
	t.Parallel()

	factory, err := NewSupervisorFactory(SupervisorFactoryConfig{
		Host: workersupervisor.HostInfo{
			Version: "2.0.0", Locale: "en", TimeZone: "Europe/Prague",
		},
		ProtocolVersion: "1.0.0",
		Target:          "windows-amd64",
		Handler: workerrpc.RequestHandlerFunc(func(context.Context, workerrpc.Request) (any, error) {
			return nil, nil
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	identity := workersupervisor.Identity{
		AddonID: "engine-addon", Version: "1.0.0", Generation: "generation-1",
	}
	for name, worker := range map[string]*packageinspect.WorkerRuntime{
		"WASI":           {Type: "wasi", Entrypoint: "worker/addon.wasm"},
		"missing target": {Type: "native", Entrypoints: map[string]string{"linux-amd64": "worker/addon"}},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			_, err := factory.New(RuntimeSpec{
				Identity: identity, RootDirectory: t.TempDir(),
				Manifest: packageinspect.Manifest{Runtime: &packageinspect.Runtime{Worker: worker}},
			})
			if !errors.Is(err, ErrRuntimeUnsupported) {
				t.Fatalf("factory error = %v", err)
			}
		})
	}
}
