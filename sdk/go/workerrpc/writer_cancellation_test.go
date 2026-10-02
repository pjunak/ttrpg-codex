package workerrpc

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestCodecCancelsBeforeOwningWriter(t *testing.T) {
	for _, deadline := range []bool{false, true} {
		t.Run(map[bool]string{false: "cancel", true: "deadline"}[deadline], func(t *testing.T) {
			output := newBlockingWriter()
			codec := newTestCodec(t, strings.NewReader(""), output, DefaultLimits)
			first := make(chan error, 1)
			go func() { first <- codec.Write(context.Background(), writerTestFrame("first")) }()
			var release sync.Once
			t.Cleanup(func() {
				release.Do(func() { close(output.release) })
				<-first
			})
			select {
			case <-output.entered:
			case <-time.After(time.Second):
				t.Fatal("first frame did not reach the writer")
			}
			ctx, cancel := context.WithCancel(context.Background())
			want := context.Canceled
			if deadline {
				cancel()
				ctx, cancel = context.WithTimeout(context.Background(), 100*time.Millisecond)
				want = context.DeadlineExceeded
			}
			defer cancel()
			marshaled := make(chan struct{})
			second := make(chan error, 1)
			beforeWrite := false
			go func() {
				second <- codec.writeFrame(ctx, announcedFrame{writerTestFrame("cancelled"), marshaled}, func() { beforeWrite = true })
			}()
			<-marshaled
			if !deadline {
				cancel()
			}
			select {
			case err := <-second:
				if !errors.Is(err, want) {
					t.Fatalf("queued frame error = %v, want %v", err, want)
				}
			case <-time.After(time.Second):
				t.Fatal("cancelled frame remained queued behind the writer")
			}
			if beforeWrite {
				t.Fatal("cancelled frame transferred writer ownership")
			}
			release.Do(func() { close(output.release) })
			if err := codec.Write(context.Background(), writerTestFrame("fresh")); err != nil {
				t.Fatalf("queued cancellation poisoned a reusable writer: %v", err)
			}
		})
	}
}

func TestCodecNeverReusesAnInterruptedFrame(t *testing.T) {
	for _, stage := range []string{"partial-header", "header", "partial-body"} {
		t.Run(stage, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			output := &cancelledPrefixWriter{stage: stage, cancel: cancel}
			codec := newTestCodec(t, strings.NewReader(""), output, DefaultLimits)
			if err := codec.Write(ctx, writerTestFrame("interrupted")); !errors.Is(err, context.Canceled) {
				t.Fatalf("interrupted frame error = %v", err)
			}
			prefix := bytes.Clone(output.Bytes())
			if len(prefix) == 0 {
				t.Fatal("fixture did not publish a frame prefix")
			}
			if err := codec.Write(context.Background(), writerTestFrame("fresh")); err == nil {
				t.Fatal("writer reused an incomplete frame stream")
			}
			if !bytes.Equal(prefix, output.Bytes()) {
				t.Fatal("a later frame was appended to the interrupted frame")
			}
		})
	}
}

func TestPeerStopsAfterFramePrefixCancellation(t *testing.T) {
	input, inputWriter := io.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	output := &cancelledPrefixWriter{stage: "header", cancel: cancel}
	terminal := make(chan error, 2)
	peer, err := NewPeer(newTestCodec(t, input, output, DefaultLimits), PeerConfig{
		IDPrefix: "prefix-cancellation", OnTerminal: func(err error) { terminal <- err },
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		peer.Close()
		_ = inputWriter.Close()
		_ = input.Close()
	})
	if err := peer.Start(); err != nil {
		t.Fatal(err)
	}
	if _, err := peer.Call(ctx, "fixture/call", map[string]any{}, nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("interrupted call error = %v", err)
	}
	select {
	case <-terminal:
	default:
		t.Fatal("partial frame cancellation left the peer usable")
	}
	if snapshot := peer.Snapshot(); !snapshot.Closed || snapshot.PendingOutgoing != 0 {
		t.Fatalf("failed transport retained routing state: %+v", snapshot)
	}
	prefix := bytes.Clone(output.Bytes())
	if _, err := peer.Call(context.Background(), "fixture/call", map[string]any{}, nil); err == nil {
		t.Fatal("closed peer accepted a fresh call")
	}
	if !bytes.Equal(prefix, output.Bytes()) {
		t.Fatal("closed peer wrote a second frame")
	}
	select {
	case <-terminal:
		t.Fatal("transport reported terminal failure more than once")
	default:
	}
}

func TestPeerQueuedCancellationKeepsUnsentCallsLocal(t *testing.T) {
	hostStream, workerStream := net.Pipe()
	output := &heldFrameWriter{Writer: hostStream, entered: make(chan struct{}), release: make(chan struct{})}
	host, err := NewPeer(newTestCodec(t, hostStream, output, DefaultLimits), PeerConfig{IDPrefix: "host"})
	if err != nil {
		t.Fatal(err)
	}
	worker, err := NewPeer(newTestCodec(t, workerStream, workerStream, DefaultLimits), PeerConfig{
		Handler: RequestHandlerFunc(func(context.Context, Request) (any, error) { return map[string]any{}, nil }),
	})
	if err != nil {
		t.Fatal(err)
	}
	var release sync.Once
	releaseOutput := func() { release.Do(func() { close(output.release) }) }
	t.Cleanup(func() {
		releaseOutput()
		host.Close()
		worker.Close()
		_ = hostStream.Close()
		_ = workerStream.Close()
	})
	if err := host.Start(); err != nil {
		t.Fatal(err)
	}
	if err := worker.Start(); err != nil {
		t.Fatal(err)
	}
	ctx, stop := context.WithTimeout(context.Background(), 4*time.Second)
	defer stop()
	first := make(chan error, 1)
	go func() {
		_, err := host.Call(ctx, "fixture/first", map[string]any{}, testMeta())
		first <- err
	}()
	select {
	case <-output.entered:
	case <-ctx.Done():
		t.Fatal("first call did not reach the writer")
	}
	queuedCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	marshaled := make(chan struct{})
	queued := make(chan error, 1)
	go func() {
		_, err := host.Call(queuedCtx, "fixture/unsent", announcedFrame{map[string]any{}, marshaled}, testMeta())
		queued <- err
	}()
	<-marshaled
	cancel()
	select {
	case err := <-queued:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("unsent call error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("unsent call retained its outgoing slot after cancellation")
	}
	if snapshot := host.Snapshot(); snapshot.Closed || snapshot.PendingOutgoing != 1 || len(host.outgoing) != 1 {
		t.Fatalf("unsent cancellation affected the active call: %+v", snapshot)
	}
	releaseOutput()
	select {
	case err := <-first:
		if err != nil {
			t.Fatal("active call failed after unrelated cancellation", err)
		}
	case <-ctx.Done():
		t.Fatal("active call did not finish after writer release")
	}
	if _, err := host.Call(ctx, "fixture/fresh", map[string]any{}, testMeta()); err != nil {
		t.Fatal("fresh call failed after queued cancellation", err)
	}
	if snapshot := worker.Snapshot(); snapshot.IncomingCalls != 2 || snapshot.CancelledIncoming != 0 || snapshot.IgnoredNotifications != 0 {
		t.Fatalf("unsent request or cancellation reached the worker: %+v", snapshot)
	}
}

func writerTestFrame(id string) map[string]any {
	return map[string]any{"jsonrpc": "2.0", "id": id, "method": "fixture/call", "params": map[string]any{}}
}

type announcedFrame struct {
	value any
	ready chan struct{}
}

func (frame announcedFrame) MarshalJSON() ([]byte, error) {
	defer close(frame.ready)
	return json.Marshal(frame.value)
}

type cancelledPrefixWriter struct {
	bytes.Buffer
	stage  string
	cancel context.CancelFunc
	calls  int
}

type heldFrameWriter struct {
	io.Writer
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func (writer *heldFrameWriter) Write(body []byte) (int, error) {
	writer.once.Do(func() { close(writer.entered) })
	<-writer.release
	return writer.Writer.Write(body)
}

func (writer *cancelledPrefixWriter) Write(body []byte) (int, error) {
	writer.calls++
	interrupt := writer.calls == 1 && writer.stage != "partial-body" || writer.calls == 2 && writer.stage == "partial-body"
	if interrupt {
		if writer.stage != "header" {
			body = body[:len(body)/2]
		}
		writer.cancel()
	}
	return writer.Buffer.Write(body)
}
