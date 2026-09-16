package workersupervisor

import (
	"errors"
	"io"
	"os"
	"testing"
	"time"

	"github.com/pjunak/ttrpg-codex/sdk/go/workerrpc"
)

func TestSupervisorDistinguishesOwnedPipeCleanupFromTransportFailure(t *testing.T) {
	for _, owned := range []bool{true, false} {
		name := "unexpected close"
		if owned {
			name = "supervisor cleanup"
		}
		t.Run(name, func(t *testing.T) {
			supervisor := newTestSupervisor(t, "healthy", nil)
			reader, writer, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			defer reader.Close()
			defer writer.Close()
			// Model the interval after accepted shutdown and process exit, while
			// the peer reader has yet to observe stdout closing.
			supervisor.state = StateStopping
			supervisor.stdout = reader
			codec, err := workerrpc.NewCodec(reader, io.Discard, workerrpc.DefaultLimits)
			if err != nil {
				t.Fatal(err)
			}
			handled := make(chan struct{})
			peer, err := workerrpc.NewPeer(codec, workerrpc.PeerConfig{
				OnTerminal: func(err error) {
					supervisor.handlePeerTerminal(err)
					close(handled)
				},
			})
			if err != nil {
				t.Fatal(err)
			}
			supervisor.peer = peer
			if err := peer.Start(); err != nil {
				t.Fatal(err)
			}
			if owned {
				supervisor.closeTransport()
			} else if err := reader.Close(); err != nil {
				t.Fatal(err)
			}
			select {
			case <-handled:
			case <-time.After(5 * time.Second):
				t.Fatal("closed pipe did not finish the peer reader")
			}
			if !errors.Is(peer.Err(), os.ErrClosed) {
				t.Fatalf("reader error = %v, want closed pipe", peer.Err())
			}
			if !owned {
				snapshot := supervisor.Snapshot()
				if snapshot.State != StateFailed || snapshot.LastError == "" {
					t.Fatalf("unexpected pipe closure did not fail the worker: %+v", snapshot)
				}
				assertLifecycleCode(t, supervisor.lastError, CodeTransportFailed)
				return
			}
			if err := supervisor.transition(StateStopped, "worker exited after graceful shutdown"); err != nil {
				t.Fatal(err)
			}
			if snapshot := supervisor.Snapshot(); snapshot.LastError != "" {
				t.Fatalf("local cleanup recorded a worker failure: %+v", snapshot)
			}
		})
	}
}

func TestSupervisorKeepsProtocolFailureDuringTransportCleanup(t *testing.T) {
	supervisor := newTestSupervisor(t, "healthy", nil)
	supervisor.state = StateStopping
	supervisor.closeTransport()
	supervisor.handlePeerTerminal(errors.New("invalid worker response"))
	assertLifecycleCode(t, supervisor.lastError, CodeTransportFailed)
	if snapshot := supervisor.Snapshot(); snapshot.State != StateFailed || snapshot.LastError == "" {
		t.Fatalf("cleanup hid a protocol failure: %+v", snapshot)
	}
}
