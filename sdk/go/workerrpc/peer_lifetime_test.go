package workerrpc

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestPeerCloseDiscardsAFrameOnItsPendingRead(t *testing.T) {
	for _, method := range []string{"fixture/domain", "codex/health"} {
		t.Run(method, func(t *testing.T) {
			frame := map[string]any{"jsonrpc": "2.0", "id": "late", "method": method, "params": map[string]any{}}
			if method == "fixture/domain" {
				frame["meta"] = testMeta()
			}
			var encoded bytes.Buffer
			encoder := newTestCodec(t, strings.NewReader(""), &encoded, DefaultLimits)
			if err := encoder.Write(context.Background(), frame); err != nil {
				t.Fatal(err)
			}
			header, body, _ := bytes.Cut(encoded.Bytes(), []byte("\r\n\r\n"))
			reader := &pausedBodyReader{
				header: bytes.NewReader(append(bytes.Clone(header), '\r', '\n', '\r', '\n')),
				body:   bytes.NewReader(body), entered: make(chan struct{}),
				resume: make(chan struct{}), consumed: make(chan struct{}),
			}
			output := &countedWriter{Writer: io.Discard}
			invoked := make(chan struct{}, 1)
			peer := lifetimeTestPeer(t, newTestCodec(t, reader, output, DefaultLimits), RequestHandlerFunc(func(context.Context, Request) (any, error) {
				invoked <- struct{}{}
				return map[string]any{}, nil
			}))
			var resume sync.Once
			resumeRead := func() { resume.Do(func() { close(reader.resume) }) }
			t.Cleanup(func() { peer.Close(); resumeRead() })
			<-reader.entered
			peer.Close()
			resumeRead()
			select {
			case <-reader.consumed:
			case <-time.After(time.Second):
				t.Fatal("the pending read did not consume its frame")
			}
			select {
			case <-invoked:
				t.Fatal("closed peer invoked a handler for a newly received frame")
			case <-time.After(100 * time.Millisecond):
			}
			if snapshot := peer.Snapshot(); snapshot.IncomingCalls != 0 || snapshot.ActiveIncoming != 0 || output.bytes.Load() != 0 {
				t.Fatalf("closed peer routed a newly received frame: %+v, written=%d", snapshot, output.bytes.Load())
			}
		})
	}
}

func TestPeerCloseReleasesWhollyUnsentCalls(t *testing.T) {
	for _, method := range []string{"fixture/domain", "codex/health"} {
		for _, cause := range []error{ErrPeerClosed, errors.New("fixture transport failure")} {
			t.Run(method+"/"+cause.Error(), func(t *testing.T) {
				peer, _, release := blockedLifetimePeer(t, nil)
				marshaled := make(chan struct{})
				result := make(chan error, 1)
				var meta *Meta
				if method == "fixture/domain" {
					meta = testMeta()
				}
				go func() {
					_, err := peer.Call(context.Background(), method, announcedFrame{map[string]any{}, marshaled}, meta)
					result <- err
				}()
				<-marshaled
				peer.stop(cause)
				select {
				case err := <-result:
					if !errors.Is(err, cause) {
						t.Fatalf("queued call lost terminal cause: %v, want %v", err, cause)
					}
				case <-time.After(500 * time.Millisecond):
					t.Fatal("closed peer retained a wholly unsent call behind the writer")
				}
				if snapshot := peer.Snapshot(); snapshot.PendingOutgoing != 0 || len(peer.outgoing) != 0 || len(peer.controlOutgoing) != 0 {
					t.Fatalf("closed peer retained outgoing admission: %+v", snapshot)
				}
				peer.mu.Lock()
				retained := len(peer.callCancellations)
				peer.mu.Unlock()
				if retained != 0 {
					t.Fatal("closed peer retained outgoing call contexts")
				}
				release()
			})
		}
	}
}

func TestPeerCloseReleasesRepliesWaitingForWriter(t *testing.T) {
	for _, method := range []string{"fixture/domain", "codex/health"} {
		for _, failed := range []bool{false, true} {
			t.Run(method+map[bool]string{false: "/success", true: "/failure"}[failed], func(t *testing.T) {
				invoked := make(chan struct{})
				marshaled := make(chan struct{})
				peer, sender, release := blockedLifetimePeer(t, RequestHandlerFunc(func(context.Context, Request) (any, error) {
					close(invoked)
					if failed {
						return nil, NewRPCError(JSONRPCApplication, KindUnavailable, "fixture unavailable", true, nil)
					}
					return announcedFrame{map[string]any{}, marshaled}, nil
				}))
				encoder := newTestCodec(t, strings.NewReader(""), sender, DefaultLimits)
				frame := map[string]any{"jsonrpc": "2.0", "id": "reply", "method": method, "params": map[string]any{}}
				if method == "fixture/domain" {
					frame["meta"] = testMeta()
				}
				if err := encoder.Write(context.Background(), frame); err != nil {
					t.Fatal(err)
				}
				<-invoked
				if !failed {
					<-marshaled
				}
				peer.Close()
				deadline := time.Now().Add(500 * time.Millisecond)
				for peer.Snapshot().ActiveIncoming != 0 || len(peer.inbound) != 0 || len(peer.controlInbound) != 0 {
					if time.Now().After(deadline) {
						t.Fatal("closed peer retained a queued reply and incoming admission")
					}
					time.Sleep(time.Millisecond)
				}
				release()
			})
		}
	}
}

func TestPeerCloseReleasesCallsWithAnEarlyResponse(t *testing.T) {
	for _, method := range []string{"fixture/domain", "codex/health"} {
		t.Run(method, func(t *testing.T) {
			peer, sender, release := blockedLifetimePeer(t, nil)
			marshaled := make(chan struct{})
			result := make(chan error, 1)
			var meta *Meta
			if method == "fixture/domain" {
				meta = testMeta()
			}
			go func() {
				_, err := peer.Call(context.Background(), method, announcedFrame{map[string]any{}, marshaled}, meta)
				result <- err
			}()
			<-marshaled
			encoder := newTestCodec(t, strings.NewReader(""), sender, DefaultLimits)
			if err := encoder.Write(context.Background(), map[string]any{
				"jsonrpc": "2.0", "id": "lifetime-1", "result": map[string]any{},
			}); err != nil {
				t.Fatal(err)
			}
			waitFor(t, func() bool { return peer.Snapshot().PendingOutgoing == 0 })
			peer.Close()
			select {
			case err := <-result:
				if !errors.Is(err, ErrPeerClosed) {
					t.Fatalf("wholly unsent call accepted an early response after closure: %v", err)
				}
			case <-time.After(500 * time.Millisecond):
				t.Fatal("early response detached a queued write from peer cancellation")
			}
			release()
		})
	}
}

func TestPeerCloseReleasesUnsentCancellationNotice(t *testing.T) {
	peer, _, release := blockedLifetimePeer(t, nil)
	done := make(chan struct{})
	go func() {
		peer.sendCancellation("cancelled-call")
		close(done)
	}()
	peer.Close()
	select {
	case <-done:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("cancellation notice waited beyond peer closure")
	}
	release()
}

func blockedLifetimePeer(t *testing.T, handler RequestHandler) (*Peer, io.Writer, func()) {
	t.Helper()
	input, sender := io.Pipe()
	output := &countedWriter{Writer: newBlockingWriter()}
	codec := newTestCodec(t, input, output, DefaultLimits)
	peer := lifetimeTestPeer(t, codec, handler)
	blocker := output.Writer.(*blockingWriter)
	first := make(chan error, 1)
	go func() { first <- codec.Write(context.Background(), writerTestFrame("owning-transport-write")) }()
	<-blocker.entered
	var once sync.Once
	release := func() {
		once.Do(func() {
			close(blocker.release)
			if err := <-first; err != nil {
				t.Error("fixture transport owner failed", err)
			}
		})
	}
	t.Cleanup(func() {
		peer.Close()
		release()
		_ = sender.Close()
		_ = input.Close()
		if output.calls.Load() != 2 {
			t.Errorf("closed peer published another frame: %d writer calls, want 2", output.calls.Load())
		}
	})
	return peer, sender, release
}

func lifetimeTestPeer(t *testing.T, codec *Codec, handler RequestHandler) *Peer {
	t.Helper()
	peer, err := NewPeer(codec, PeerConfig{IDPrefix: "lifetime", Handler: handler})
	if err != nil {
		t.Fatal(err)
	}
	if err := peer.Start(); err != nil {
		t.Fatal(err)
	}
	return peer
}

type pausedBodyReader struct {
	header       *bytes.Reader
	body         *bytes.Reader
	entered      chan struct{}
	resume       chan struct{}
	consumed     chan struct{}
	once         sync.Once
	consumedOnce sync.Once
}

func (reader *pausedBodyReader) Read(body []byte) (int, error) {
	if reader.header.Len() > 0 {
		return reader.header.Read(body)
	}
	reader.once.Do(func() { close(reader.entered) })
	<-reader.resume
	written, err := reader.body.Read(body)
	if reader.body.Len() == 0 {
		reader.consumedOnce.Do(func() { close(reader.consumed) })
	}
	return written, err
}

type countedWriter struct {
	io.Writer
	bytes atomic.Int64
	calls atomic.Int64
}

func (writer *countedWriter) Write(body []byte) (int, error) {
	written, err := writer.Writer.Write(body)
	writer.calls.Add(1)
	writer.bytes.Add(int64(written))
	return written, err
}
