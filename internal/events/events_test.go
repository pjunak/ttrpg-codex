package events

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	storage "github.com/pjunak/ttrpg-codex/internal/storage/sqlite"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/migrations"
)

func TestBrokerPersistsRoleScopedReplayAndNotifiesSubscribers(t *testing.T) {
	t.Parallel()
	broker := testBroker(t, Config{})
	dm, err := broker.Subscribe(AudienceDM)
	if err != nil {
		t.Fatal(err)
	}
	defer dm.Close()
	player, err := broker.Subscribe(AudiencePublic)
	if err != nil {
		t.Fatal(err)
	}
	defer player.Close()
	public, err := broker.Publish(context.Background(), Publication{
		Audience: AudiencePublic, Topic: "browser-addons-changed",
		Revision: "graph-1", Metadata: map[string]any{"source": "activation"},
	})
	if err != nil {
		t.Fatal(err)
	}
	private, err := broker.Publish(context.Background(), Publication{
		Audience: AudienceDM, Topic: "admin-diagnostic", ResourceID: "addon-1",
		Revision: "diagnostic-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if received := <-dm.Events; received.Sequence != public.Sequence {
		t.Fatalf("DM public event = %+v", received)
	}
	if received := <-dm.Events; received.Sequence != private.Sequence {
		t.Fatalf("DM private event = %+v", received)
	}
	if received := <-player.Events; received.Sequence != public.Sequence {
		t.Fatalf("player public event = %+v", received)
	}
	select {
	case unexpected := <-player.Events:
		t.Fatalf("player received DM event %+v", unexpected)
	default:
	}

	dmReplay, err := broker.Replay(context.Background(), AudienceDM, 0, 10)
	if err != nil || len(dmReplay.Events) != 2 || dmReplay.Latest != private.Sequence {
		t.Fatalf("DM replay = %+v, %v", dmReplay, err)
	}
	playerReplay, err := broker.Replay(context.Background(), AudiencePublic, 0, 10)
	if err != nil || len(playerReplay.Events) != 1 || playerReplay.Latest != public.Sequence {
		t.Fatalf("player replay = %+v, %v", playerReplay, err)
	}
}

func TestBrokerBoundsReplayAndDropsSlowSubscribers(t *testing.T) {
	t.Parallel()
	broker := testBroker(t, Config{MaxSubscribers: 1, SubscriberSize: 1})
	subscription, err := broker.Subscribe(AudiencePublic)
	if err != nil {
		t.Fatal(err)
	}
	defer subscription.Close()
	if _, err := broker.Subscribe(AudiencePublic); !errors.Is(err, ErrSubscriberCapacity) {
		t.Fatalf("subscriber capacity error = %v", err)
	}
	for index := 1; index <= 3; index++ {
		_, err := broker.Publish(context.Background(), Publication{
			Audience: AudiencePublic, Topic: "data-changed", Revision: string(rune('0' + index)),
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	if _, open := <-subscription.Events; !open {
		t.Fatal("buffered event disappeared when slow subscriber was dropped")
	}
	if _, open := <-subscription.Events; open {
		t.Fatal("slow subscriber channel remained open")
	}
	replay, err := broker.Replay(context.Background(), AudiencePublic, 0, 2)
	if err != nil || !replay.Truncated || len(replay.Events) != 2 || replay.Latest != 3 {
		t.Fatalf("bounded replay = %+v, %v", replay, err)
	}
}

func TestBrokerRejectsInvalidPublications(t *testing.T) {
	t.Parallel()
	broker := testBroker(t, Config{})
	for _, publication := range []Publication{
		{Audience: "player", Topic: "data-changed", Revision: "1"},
		{Audience: AudiencePublic, Topic: "Bad Topic", Revision: "1"},
		{Audience: AudiencePublic, Topic: "data-changed", Revision: ""},
		{Audience: AudiencePublic, Topic: "data-changed", Revision: "1", Metadata: []string{"not", "object"}},
	} {
		if _, err := broker.Publish(context.Background(), publication); !errors.Is(err, ErrInvalidPublication) {
			t.Fatalf("publication %+v error = %v", publication, err)
		}
	}
}

func testBroker(t *testing.T, config Config) *Broker {
	t.Helper()
	db, err := storage.Open(context.Background(), filepath.Join(t.TempDir(), "codex.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if _, err := storage.Migrate(context.Background(), db, migrations.FS); err != nil {
		t.Fatal(err)
	}
	config.DB = db
	config.Now = func() time.Time { return time.Date(2026, time.August, 31, 12, 0, 0, 0, time.UTC) }
	broker, err := New(config)
	if err != nil {
		t.Fatal(err)
	}
	return broker
}
