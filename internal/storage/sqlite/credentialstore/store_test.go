package credentialstore

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pjunak/ttrpg-codex/internal/auth"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/migrations"
)

func TestStoredPasswordsSurviveReopenAndOfflineReset(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "codex.db")
	db, err := sqlite.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := sqlite.Migrate(ctx, db, migrations.FS); err != nil {
		t.Fatal(err)
	}
	store := Store{DB: db}
	service, err := auth.New(auth.Config{CredentialStore: store, DMPassword: "initial-dm", PlayerPassword: "initial-player"})
	if err != nil {
		t.Fatal(err)
	}
	dm, _ := service.Login("initial-dm")
	if _, err := service.ChangePassword(ctx, dm.Token, dm.CSRFToken, "initial-dm", auth.RoleDM, "saved-password", 1); err != nil {
		t.Fatal(err)
	}
	var raw string
	if err := db.QueryRow("SELECT value_json FROM host_credentials").Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(raw, "saved-password") || strings.Contains(raw, "initial-") {
		t.Fatal("clear text password was stored")
	}
	value, _, _ := store.Load(ctx)
	if err := store.Save(ctx, value, 1); !errors.Is(err, auth.ErrCredentialConflict) {
		t.Fatal("stale revision accepted")
	}
	db.Close()
	db, err = sqlite.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	store = Store{DB: db}
	reopened, err := auth.New(auth.Config{CredentialStore: store})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := reopened.Login("saved-password"); err != nil {
		t.Fatal(err)
	}
	if err := auth.ResetCredentials(ctx, store, "recovered-dm", ""); err != nil {
		t.Fatal(err)
	}
	reset, err := auth.New(auth.Config{CredentialStore: store})
	if err != nil {
		t.Fatal(err)
	}
	if reset.CredentialStatus().PlayerEnabled {
		t.Fatal("offline reset revived player access")
	}
	if _, err := reset.Login("recovered-dm"); err != nil {
		t.Fatal(err)
	}
	if _, err := reset.Login("saved-password"); !errors.Is(err, auth.ErrInvalidCredentials) {
		t.Fatal("reset retained previous password")
	}
	if _, err := db.Exec("UPDATE host_credentials SET value_json = '{}' WHERE singleton = 1"); err != nil {
		t.Fatal(err)
	}
	if _, err := auth.New(auth.Config{CredentialStore: store, DMPassword: "fallback-dm"}); !errors.Is(err, auth.ErrInvalidConfig) {
		t.Fatal("invalid saved credentials fell back to environment")
	}
}
