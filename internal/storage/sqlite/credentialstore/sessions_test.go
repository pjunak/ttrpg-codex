package credentialstore

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/auth"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/migrations"
)

func TestSessionsSurviveRestartUntilRevokedOrExpired(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	db, err := sqlite.Open(ctx, filepath.Join(t.TempDir(), "codex.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := sqlite.Migrate(ctx, db, migrations.FS); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, time.October, 11, 12, 0, 0, 0, time.UTC)
	start := func() *auth.Service {
		t.Helper()
		service, err := auth.New(auth.Config{
			CredentialStore: Store{DB: db}, SessionStore: Store{DB: db},
			DMPassword: "dm-secret", PlayerPassword: "player-secret",
			SessionTTL: time.Hour, Now: func() time.Time { return now },
		})
		if err != nil {
			t.Fatal(err)
		}
		return service
	}
	service := start()
	dm, err := service.Login("dm-secret")
	if err != nil {
		t.Fatal(err)
	}
	player, _ := service.Login("player-secret")
	leaving, _ := service.Login("player-secret")
	preview, err := service.CreatePlayerPreview(dm.Token)
	if err != nil {
		t.Fatal(err)
	}
	if err := service.Revoke(leaving.Token); err != nil {
		t.Fatal(err)
	}

	restarted := start()
	if actor, ok := restarted.Resolve(dm.Token); !ok || actor != dm.Actor ||
		!restarted.ValidateCSRF(dm.Token, dm.CSRFToken) {
		t.Fatalf("DM session after restart = %+v, %v", actor, ok)
	}
	if actor, ok := restarted.Resolve(player.Token); !ok || actor != player.Actor {
		t.Fatalf("player session after restart = %+v, %v", actor, ok)
	}
	if _, ok := restarted.InspectPlayerPreview(preview.Token); !ok {
		t.Fatal("player preview did not survive restart")
	}
	if _, ok := restarted.Resolve(leaving.Token); ok {
		t.Fatal("signed-out session survived restart")
	}

	if _, err := restarted.ChangePassword(ctx, dm.Token, dm.CSRFToken, "dm-secret", auth.RolePlayer, "new-player", 1); err != nil {
		t.Fatal(err)
	}
	restarted = start()
	for name, token := range map[string]string{"player": player.Token, "preview": preview.Token} {
		if _, ok := restarted.Resolve(token); ok {
			t.Fatalf("%s session revoked by a password change survived restart", name)
		}
	}
	if _, ok := restarted.Resolve(dm.Token); !ok {
		t.Fatal("reviewing DM lost the session across restart")
	}

	now = now.Add(time.Hour)
	restarted = start()
	if _, ok := restarted.Resolve(dm.Token); ok {
		t.Fatal("expired session survived restart")
	}
	var remaining int
	if err := db.QueryRow(`SELECT count(*) FROM host_sessions`).Scan(&remaining); err != nil || remaining != 0 {
		t.Fatalf("saved sessions after expiry = %d, %v", remaining, err)
	}
}
