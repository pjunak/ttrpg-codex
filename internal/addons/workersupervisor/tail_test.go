package workersupervisor

import "testing"

func TestTailBufferKeepsOnlyNewestBytes(t *testing.T) {
	t.Parallel()

	buffer := newTailBuffer(8)
	_, _ = buffer.Write([]byte("abcd"))
	_, _ = buffer.Write([]byte("efghij"))
	if got := buffer.String(); got != "cdefghij" {
		t.Fatalf("tail = %q", got)
	}
	_, _ = buffer.Write([]byte("0123456789"))
	if got := buffer.String(); got != "23456789" {
		t.Fatalf("replacement tail = %q", got)
	}
}
