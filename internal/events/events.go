package events

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sync"
	"time"
)

const (
	DefaultReplayLimit = 256
	MaximumReplayLimit = 1_000
	defaultSubscribers = 256
	defaultBuffer      = 32
	maximumMetadata    = 16 << 10
)

var (
	ErrInvalidConfig      = errors.New("invalid event configuration")
	ErrInvalidPublication = errors.New("invalid event publication")
	ErrSubscriberCapacity = errors.New("event subscriber capacity reached")
	topicPattern          = regexp.MustCompile(`^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`)
)

type Audience string

const (
	AudiencePublic Audience = "public"
	AudienceDM     Audience = "dm"
	AudienceSystem Audience = "system"
)

type Event struct {
	Sequence   int64           `json:"sequence"`
	Audience   Audience        `json:"-"`
	Topic      string          `json:"topic"`
	ResourceID string          `json:"resourceId,omitempty"`
	Revision   string          `json:"revision"`
	OccurredAt time.Time       `json:"occurredAt"`
	Metadata   json.RawMessage `json:"metadata"`
}

type Publication struct {
	Audience   Audience
	Topic      string
	ResourceID string
	Revision   string
	Metadata   any
}

type Replay struct {
	Events    []Event
	Latest    int64
	Truncated bool
}

type Config struct {
	DB             *sql.DB
	Now            func() time.Time
	MaxSubscribers int
	SubscriberSize int
}

type Broker struct {
	db               *sql.DB
	now              func() time.Time
	maxSubscribers   int
	subscriberBuffer int

	mu             sync.Mutex
	nextSubscriber uint64
	subscribers    map[uint64]*subscriber
}

type eventExecer interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

type subscriber struct {
	audience Audience
	events   chan Event
}

type Subscription struct {
	Events <-chan Event
	cancel func()
	once   sync.Once
}

func New(config Config) (*Broker, error) {
	if config.DB == nil {
		return nil, fmt.Errorf("%w: database is required", ErrInvalidConfig)
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	if config.MaxSubscribers == 0 {
		config.MaxSubscribers = defaultSubscribers
	}
	if config.SubscriberSize == 0 {
		config.SubscriberSize = defaultBuffer
	}
	if config.MaxSubscribers < 1 || config.MaxSubscribers > 100_000 ||
		config.SubscriberSize < 1 || config.SubscriberSize > 10_000 {
		return nil, fmt.Errorf("%w: subscriber limits are invalid", ErrInvalidConfig)
	}
	return &Broker{
		db: config.DB, now: config.Now,
		maxSubscribers: config.MaxSubscribers, subscriberBuffer: config.SubscriberSize,
		subscribers: make(map[uint64]*subscriber),
	}, nil
}

func (broker *Broker) Publish(ctx context.Context, publication Publication) (Event, error) {
	if broker == nil || broker.db == nil {
		return Event{}, ErrInvalidConfig
	}
	event, err := broker.append(ctx, broker.db, publication)
	if err != nil {
		return Event{}, err
	}
	broker.notify(event)
	return cloneEvent(event), nil
}

// Append records an event inside a caller-owned transaction. The caller must
// invoke NotifyCommitted only after that transaction commits successfully.
func (broker *Broker) Append(
	ctx context.Context,
	tx *sql.Tx,
	publication Publication,
) (Event, error) {
	if broker == nil || broker.db == nil || tx == nil {
		return Event{}, ErrInvalidConfig
	}
	return broker.append(ctx, tx, publication)
}

// NotifyCommitted wakes live subscribers for an event already durably
// committed by Append. Replay remains authoritative if this process stops
// between commit and notification.
func (broker *Broker) NotifyCommitted(event Event) {
	if broker == nil || event.Sequence < 1 {
		return
	}
	broker.notify(cloneEvent(event))
}

func (broker *Broker) append(
	ctx context.Context,
	execer eventExecer,
	publication Publication,
) (Event, error) {
	metadata, err := normalizeMetadata(publication.Metadata)
	if err != nil {
		return Event{}, fmt.Errorf("%w: %v", ErrInvalidPublication, err)
	}
	if !validPublication(publication) {
		return Event{}, ErrInvalidPublication
	}
	occurredAt := broker.now().UTC()
	result, err := execer.ExecContext(ctx, `
		INSERT INTO change_log(audience, topic, resource_id, revision, occurred_at, metadata_json)
		VALUES (?, ?, NULLIF(?, ''), ?, ?, ?)`,
		publication.Audience, publication.Topic, publication.ResourceID,
		publication.Revision, occurredAt.Format(time.RFC3339Nano), string(metadata),
	)
	if err != nil {
		return Event{}, fmt.Errorf("publish event: %w", err)
	}
	sequence, err := result.LastInsertId()
	if err != nil {
		return Event{}, fmt.Errorf("read published event sequence: %w", err)
	}
	event := Event{
		Sequence: sequence, Audience: publication.Audience, Topic: publication.Topic,
		ResourceID: publication.ResourceID, Revision: publication.Revision,
		OccurredAt: occurredAt, Metadata: metadata,
	}
	return cloneEvent(event), nil
}

func (broker *Broker) Replay(ctx context.Context, audience Audience, after int64, limit int) (Replay, error) {
	if broker == nil || broker.db == nil || !browserAudience(audience) || after < 0 {
		return Replay{}, ErrInvalidPublication
	}
	if limit == 0 {
		limit = DefaultReplayLimit
	}
	if limit < 1 || limit > MaximumReplayLimit {
		return Replay{}, ErrInvalidPublication
	}
	latest, err := broker.latest(ctx, audience)
	if err != nil {
		return Replay{}, err
	}
	rows, err := broker.db.QueryContext(ctx, `
		SELECT sequence, audience, topic, COALESCE(resource_id, ''), revision, occurred_at, metadata_json
		FROM change_log
		WHERE sequence > ? AND (audience = 'public' OR audience = ?)
		ORDER BY sequence
		LIMIT ?`, after, audience, limit+1)
	if err != nil {
		return Replay{}, fmt.Errorf("query event replay: %w", err)
	}
	defer rows.Close()
	values := make([]Event, 0, limit+1)
	for rows.Next() {
		event, err := scanEvent(rows)
		if err != nil {
			return Replay{}, err
		}
		values = append(values, event)
	}
	if err := rows.Err(); err != nil {
		return Replay{}, fmt.Errorf("iterate event replay: %w", err)
	}
	truncated := len(values) > limit
	if truncated {
		values = values[:limit]
	}
	return Replay{Events: values, Latest: latest, Truncated: truncated}, nil
}

func (broker *Broker) Latest(ctx context.Context, audience Audience) (int64, error) {
	if broker == nil || broker.db == nil || !browserAudience(audience) {
		return 0, ErrInvalidPublication
	}
	return broker.latest(ctx, audience)
}

func (broker *Broker) latest(ctx context.Context, audience Audience) (int64, error) {
	row := broker.db.QueryRowContext(ctx, `
		SELECT COALESCE(MAX(sequence), 0)
		FROM change_log
		WHERE audience = 'public' OR audience = ?`, audience)
	var sequence int64
	if err := row.Scan(&sequence); err != nil {
		return 0, fmt.Errorf("read latest event sequence: %w", err)
	}
	return sequence, nil
}

func (broker *Broker) Subscribe(audience Audience) (*Subscription, error) {
	if broker == nil || !browserAudience(audience) {
		return nil, ErrInvalidPublication
	}
	broker.mu.Lock()
	defer broker.mu.Unlock()
	if len(broker.subscribers) >= broker.maxSubscribers {
		return nil, ErrSubscriberCapacity
	}
	broker.nextSubscriber++
	id := broker.nextSubscriber
	entry := &subscriber{audience: audience, events: make(chan Event, broker.subscriberBuffer)}
	broker.subscribers[id] = entry
	return &Subscription{
		Events: entry.events,
		cancel: func() {
			broker.mu.Lock()
			defer broker.mu.Unlock()
			current, exists := broker.subscribers[id]
			if exists && current == entry {
				delete(broker.subscribers, id)
				close(entry.events)
			}
		},
	}, nil
}

func (subscription *Subscription) Close() {
	if subscription == nil {
		return
	}
	subscription.once.Do(subscription.cancel)
}

func (broker *Broker) notify(event Event) {
	broker.mu.Lock()
	defer broker.mu.Unlock()
	for id, entry := range broker.subscribers {
		if event.Audience != AudiencePublic && event.Audience != entry.audience {
			continue
		}
		select {
		case entry.events <- cloneEvent(event):
		default:
			delete(broker.subscribers, id)
			close(entry.events)
		}
	}
}

func validPublication(publication Publication) bool {
	return (publication.Audience == AudiencePublic || publication.Audience == AudienceDM ||
		publication.Audience == AudienceSystem) &&
		topicPattern.MatchString(publication.Topic) && len(publication.Topic) <= 100 &&
		len(publication.ResourceID) <= 200 && len(publication.Revision) > 0 &&
		len(publication.Revision) <= 200
}

func browserAudience(audience Audience) bool {
	return audience == AudiencePublic || audience == AudienceDM
}

func normalizeMetadata(value any) (json.RawMessage, error) {
	if value == nil {
		return json.RawMessage(`{}`), nil
	}
	body, err := json.Marshal(value)
	if err != nil || len(body) > maximumMetadata {
		return nil, errors.New("metadata must be bounded JSON")
	}
	var object map[string]any
	if err := json.Unmarshal(body, &object); err != nil || object == nil {
		return nil, errors.New("metadata must be a JSON object")
	}
	canonical, err := json.Marshal(object)
	if err != nil || len(canonical) > maximumMetadata {
		return nil, errors.New("metadata must be bounded JSON")
	}
	return canonical, nil
}

func scanEvent(row interface{ Scan(...any) error }) (Event, error) {
	var event Event
	var occurredAt, metadata string
	if err := row.Scan(
		&event.Sequence, &event.Audience, &event.Topic, &event.ResourceID,
		&event.Revision, &occurredAt, &metadata,
	); err != nil {
		return Event{}, fmt.Errorf("scan event: %w", err)
	}
	parsedAt, err := time.Parse(time.RFC3339Nano, occurredAt)
	if err != nil || !json.Valid([]byte(metadata)) {
		return Event{}, errors.New("stored event is invalid")
	}
	event.OccurredAt = parsedAt
	event.Metadata = json.RawMessage(metadata)
	return event, nil
}

func cloneEvent(event Event) Event {
	event.Metadata = append(json.RawMessage(nil), event.Metadata...)
	return event
}
