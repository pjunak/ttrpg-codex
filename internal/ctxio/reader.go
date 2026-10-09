// Package ctxio stops long reads when their context ends.
package ctxio

import (
	"context"
	"io"
)

// Reader returns a reader that fails with the context's error once ctx is
// done, checked before each read of source.
func Reader(ctx context.Context, source io.Reader) io.Reader {
	return &reader{ctx: ctx, source: source}
}

type reader struct {
	ctx    context.Context
	source io.Reader
}

func (r *reader) Read(buffer []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.source.Read(buffer)
}
