package workerrpc

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"testing"
)

func TestCodecRoundTripsEveryEnvelopeKind(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		kind  MessageKind
		value map[string]any
	}{
		{"request", KindRequest, map[string]any{"jsonrpc": "2.0", "id": "1", "method": "codex/initialize", "params": map[string]any{}}},
		{"notification", KindNotification, map[string]any{"jsonrpc": "2.0", "method": "$/cancelRequest", "params": map[string]any{"id": "1"}}},
		{"success", KindSuccess, map[string]any{"jsonrpc": "2.0", "id": "1", "result": map[string]any{"ready": true}}},
		{"failure", KindFailure, map[string]any{"jsonrpc": "2.0", "id": "1", "error": map[string]any{"code": -32600, "message": "bad request"}}},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			var transport bytes.Buffer
			writer := newTestCodec(t, strings.NewReader(""), &transport, DefaultLimits)
			if err := writer.Write(context.Background(), test.value); err != nil {
				t.Fatal(err)
			}
			reader := newTestCodec(t, &transport, io.Discard, DefaultLimits)
			message, err := reader.Read(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if message.Kind != test.kind {
				t.Fatalf("kind = %s, want %s", message.Kind, test.kind)
			}
			if message.Value["jsonrpc"] != "2.0" || !json.Valid(message.Raw) {
				t.Fatalf("invalid decoded message: %+v", message)
			}
		})
	}
}

func TestCodecRejectsInvalidHeaders(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		frame string
		code  string
	}{
		{"bare LF", "Content-Length: 2\n\n{}", CodeMalformedHeader},
		{"missing length", "\r\n\r\n{}", CodeMissingContentLength},
		{"unsupported header", "Content-Type: application/json\r\n\r\n{}", CodeUnsupportedHeader},
		{"duplicate length", "Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}", CodeDuplicateContentLength},
		{"non-decimal length", "Content-Length: 2x\r\n\r\n{}", CodeInvalidContentLength},
		{"zero length", "Content-Length: 0\r\n\r\n", CodeInvalidContentLength},
		{"oversized body", "Content-Length: 33\r\n\r\n", CodeFrameTooLarge},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			codec := newTestCodec(t, strings.NewReader(test.frame), io.Discard, Limits{MaxFrameBytes: 32})
			_, err := codec.Read(context.Background())
			assertProtocolCode(t, err, test.code)
		})
	}
}

func TestCodecEnforcesHeaderAndBodyBoundaries(t *testing.T) {
	t.Parallel()

	t.Run("header limit", func(t *testing.T) {
		t.Parallel()
		codec := newTestCodec(t, strings.NewReader("Content-Length: 2\r\n\r\n{}"), io.Discard, Limits{MaxHeaderBytes: 8})
		_, err := codec.Read(context.Background())
		assertProtocolCode(t, err, CodeHeaderTooLarge)
	})

	t.Run("truncated body", func(t *testing.T) {
		t.Parallel()
		codec := newTestCodec(t, strings.NewReader("Content-Length: 8\r\n\r\n{}"), io.Discard, DefaultLimits)
		_, err := codec.Read(context.Background())
		assertProtocolCode(t, err, CodeTruncatedFrame)
	})

	t.Run("clean eof", func(t *testing.T) {
		t.Parallel()
		codec := newTestCodec(t, strings.NewReader(""), io.Discard, DefaultLimits)
		_, err := codec.Read(context.Background())
		if !errors.Is(err, io.EOF) {
			t.Fatalf("error = %v, want EOF", err)
		}
	})
}

func TestCodecRejectsInvalidBodies(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		body []byte
		code string
	}{
		{"invalid UTF-8", []byte{0xff}, CodeInvalidUTF8},
		{"invalid JSON", []byte(`{"jsonrpc":`), CodeInvalidJSON},
		{"batch", []byte(`[]`), CodeInvalidEnvelope},
		{"missing version", []byte(`{"id":"1","method":"test"}`), CodeInvalidEnvelope},
		{"unknown property", []byte(`{"jsonrpc":"2.0","id":"1","method":"test","private":true}`), CodeInvalidEnvelope},
		{"invalid metadata deadline", []byte(`{"jsonrpc":"2.0","id":"1","method":"test","meta":{"requestId":"r","correlationId":"c","generation":"g","deadline":"tomorrow"}}`), CodeInvalidEnvelope},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			frame := append([]byte(fmt.Sprintf("Content-Length: %d\r\n\r\n", len(test.body))), test.body...)
			codec := newTestCodec(t, bytes.NewReader(frame), io.Discard, DefaultLimits)
			_, err := codec.Read(context.Background())
			assertProtocolCode(t, err, test.code)
		})
	}
}

func TestCodecValidatesBeforeWriting(t *testing.T) {
	t.Parallel()

	var transport bytes.Buffer
	codec := newTestCodec(t, strings.NewReader(""), &transport, Limits{MaxFrameBytes: 64})
	err := codec.Write(context.Background(), map[string]any{
		"jsonrpc": "2.0",
		"id":      "1",
		"method":  "test",
		"extra":   strings.Repeat("x", 100),
	})
	assertProtocolCode(t, err, CodeFrameTooLarge)
	if transport.Len() != 0 {
		t.Fatalf("invalid frame wrote %d bytes", transport.Len())
	}

	err = codec.Write(context.Background(), map[string]any{"jsonrpc": "2.0", "method": ""})
	assertProtocolCode(t, err, CodeInvalidEnvelope)
	if transport.Len() != 0 {
		t.Fatalf("invalid envelope wrote %d bytes", transport.Len())
	}
}

func TestCodecSerializesConcurrentWriters(t *testing.T) {
	t.Parallel()

	var transport bytes.Buffer
	codec := newTestCodec(t, strings.NewReader(""), &transport, DefaultLimits)
	var wait sync.WaitGroup
	for index := range 20 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			if err := codec.Write(context.Background(), map[string]any{
				"jsonrpc": "2.0",
				"id":      index,
				"method":  "test",
			}); err != nil {
				t.Errorf("write: %v", err)
			}
		}()
	}
	wait.Wait()

	reader := newTestCodec(t, &transport, io.Discard, DefaultLimits)
	for range 20 {
		if _, err := reader.Read(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := reader.Read(context.Background()); !errors.Is(err, io.EOF) {
		t.Fatalf("final read = %v, want EOF", err)
	}
}

func TestCodecHonorsAlreadyCancelledContext(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	codec := newTestCodec(t, strings.NewReader("Content-Length: 2\r\n\r\n{}"), io.Discard, DefaultLimits)
	if _, err := codec.Read(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("read error = %v", err)
	}
	if err := codec.Write(ctx, map[string]any{"jsonrpc": "2.0", "method": "test"}); !errors.Is(err, context.Canceled) {
		t.Fatalf("write error = %v", err)
	}
}

func newTestCodec(t *testing.T, reader io.Reader, writer io.Writer, limits Limits) *Codec {
	t.Helper()
	codec, err := NewCodec(reader, writer, limits)
	if err != nil {
		t.Fatal(err)
	}
	return codec
}

func assertProtocolCode(t *testing.T, err error, want string) {
	t.Helper()
	if err == nil {
		t.Fatalf("protocol operation succeeded, want %s", want)
	}
	var protocol *ProtocolError
	if !errors.As(err, &protocol) {
		t.Fatalf("got %T %v, want ProtocolError", err, err)
	}
	if protocol.Code != want {
		t.Fatalf("code = %s, want %s: %v", protocol.Code, want, err)
	}
}
