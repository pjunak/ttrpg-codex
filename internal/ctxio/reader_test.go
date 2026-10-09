package ctxio

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"
)

func TestReaderStopsWhenContextEnds(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	reader := Reader(ctx, strings.NewReader("campaign"))
	buffer := make([]byte, 4)
	if n, err := reader.Read(buffer); err != nil || string(buffer[:n]) != "camp" {
		t.Fatalf("first read = %q, %v", buffer[:n], err)
	}
	cancel()
	if _, err := io.ReadAll(reader); !errors.Is(err, context.Canceled) {
		t.Fatalf("read after cancel: %v", err)
	}
}
