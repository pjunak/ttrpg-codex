package campaign

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

var (
	ErrInvalidTransaction = errors.New("invalid campaign transaction")
	ErrConflict           = errors.New("campaign record revision conflict")
	ErrNotFound           = errors.New("campaign record not found")
)

type OperationKind string

const (
	Put    OperationKind = "put"
	Delete OperationKind = "delete"
)

type Mutation struct {
	Kind             OperationKind
	Collection       Collection
	Key              string
	Value            json.RawMessage
	ExpectedRevision int64
}

type Transaction struct {
	ActorID   string
	Mutations []Mutation
}

type MutationResult struct {
	Collection     Collection `json:"collection"`
	Key            string     `json:"key"`
	BeforeRevision int64      `json:"beforeRevision"`
	AfterRevision  int64      `json:"afterRevision"`
	Deleted        bool       `json:"deleted"`
	Visibility     Visibility `json:"-"`
}

type Commit struct {
	ID                  int64                `json:"id"`
	OccurredAt          time.Time            `json:"occurredAt"`
	Results             []MutationResult     `json:"results"`
	CollectionRevisions map[Collection]int64 `json:"collectionRevisions"`
}

type Record struct {
	Collection Collection
	Key        string
	Position   int64
	Value      json.RawMessage
	Visibility Visibility
	Revision   int64
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

type RecordState struct {
	Revision int64
	Exists   bool
}

type CollectionState struct {
	Collection   Collection
	Shape        Shape
	Materialized bool
	Revision     int64
	UpdatedAt    *time.Time
}

type Snapshot struct {
	States  []CollectionState
	Records []Record
}

func (snapshot Snapshot) LegacyDataset(
	passthrough map[string]json.RawMessage,
) LegacyDataset {
	dataset := LegacyDataset{
		Present:     make([]Collection, 0),
		Records:     make([]LegacyRecord, 0, len(snapshot.Records)),
		Passthrough: make(map[string]json.RawMessage, len(passthrough)),
	}
	for name, value := range passthrough {
		dataset.Passthrough[name] = append(json.RawMessage(nil), value...)
	}
	for _, state := range snapshot.States {
		if state.Materialized {
			dataset.Present = append(dataset.Present, state.Collection)
		}
	}
	for _, record := range snapshot.Records {
		dataset.Records = append(dataset.Records, LegacyRecord{
			Collection: record.Collection,
			Key:        record.Key,
			Value:      append(json.RawMessage(nil), record.Value...),
			Position:   record.Position,
		})
	}
	return dataset
}

type ConflictError struct {
	Collection Collection
	Key        string
	Expected   int64
	Actual     int64
}

func (err *ConflictError) Error() string {
	return fmt.Sprintf(
		"%s %q revision is %d, expected %d",
		err.Collection,
		err.Key,
		err.Actual,
		err.Expected,
	)
}

func (err *ConflictError) Unwrap() error { return ErrConflict }
