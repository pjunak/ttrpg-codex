package packagemanager

import (
	"context"
	"errors"
	"testing"
)

// stoppedRows ends iteration the way *sql.Rows does when its request context
// is cancelled: Next reports no more rows and Err holds the reason.
type stoppedRows struct{ closed bool }

func (rows *stoppedRows) Next() bool        { return false }
func (rows *stoppedRows) Scan(...any) error { return errors.New("no current row") }
func (rows *stoppedRows) Err() error        { return context.Canceled }
func (rows *stoppedRows) Close() error      { rows.closed = true; return nil }

func TestGenerationListingThatStopsEarlyIsAnError(t *testing.T) {
	t.Parallel()
	rows := &stoppedRows{}
	generations, err := readGenerations(rows)
	if !errors.Is(err, context.Canceled) || generations != nil {
		t.Fatalf("stopped listing = %+v, %v", generations, err)
	}
	if !rows.closed {
		t.Fatal("stopped listing left its rows open")
	}
}
