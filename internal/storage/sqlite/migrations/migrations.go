package migrations

import "embed"

// FS contains the immutable forward-only migration history.
//
//go:embed *.sql
var FS embed.FS
