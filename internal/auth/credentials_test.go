package auth

import (
	"context"
	"errors"
	"sync"
	"testing"
)

type memoryCredentials struct {
	value Credentials
	fail  bool
}

func (store *memoryCredentials) Load(context.Context) (Credentials, bool, error) {
	return store.value, store.value.Revision > 0, nil
}
func (store *memoryCredentials) Save(_ context.Context, value Credentials, expected int64) error {
	if store.fail {
		return errors.New("storage unavailable")
	}
	if store.value.Revision != expected {
		return ErrCredentialConflict
	}
	store.value = value
	return nil
}

func TestPasswordChangesPersistAndRevokeOnlyAfterCommit(t *testing.T) {
	t.Parallel()
	store := &memoryCredentials{}
	service, err := New(Config{DMPassword: "old-dm", PlayerPassword: "old-player", CredentialStore: store})
	if err != nil {
		t.Fatal(err)
	}
	dm, _ := service.Login("old-dm")
	otherDM, _ := service.Login("old-dm")
	player, _ := service.Login("old-player")
	preview, _ := service.CreatePlayerPreview(dm.Token)
	change := func(role Role, password string, revision int64) error {
		_, err := service.ChangePassword(context.Background(), dm.Token, dm.CSRFToken, "old-dm", role, password, revision)
		return err
	}
	store.fail = true
	if err := change(RoleDM, "new-dm", 1); err == nil {
		t.Fatal("failed store accepted change")
	}
	if _, ok := service.Resolve(otherDM.Token); !ok {
		t.Fatal("failure revoked old session")
	}
	if _, err := service.Login("old-dm"); err != nil {
		t.Fatal("failure changed password")
	}
	store.fail = false
	if err := change(RoleDM, "new-dm", 1); err != nil {
		t.Fatal(err)
	}
	if _, ok := service.Resolve(dm.Token); !ok {
		t.Fatal("reviewing DM lost session")
	}
	for _, token := range []string{otherDM.Token, preview.Token} {
		if _, ok := service.Resolve(token); ok {
			t.Fatal("affected session survived rotation")
		}
	}
	if _, ok := service.Resolve(player.Token); !ok {
		t.Fatal("DM change revoked ordinary player")
	}
	if _, err := service.Login("old-dm"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatal("old DM password survived")
	}
	restarted, err := New(Config{CredentialStore: store, DMPassword: "ignored-environment", PlayerPassword: "ignored-player"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := restarted.Login("new-dm"); err != nil {
		t.Fatal(err)
	}
	if _, err := restarted.Login("ignored-environment"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatal("environment replaced saved credential")
	}
	status, err := service.ChangePassword(context.Background(), dm.Token, dm.CSRFToken, "new-dm", RolePlayer, "", 2)
	if err != nil || status.PlayerEnabled {
		t.Fatalf("disable = %+v, %v", status, err)
	}
	if _, ok := service.Resolve(player.Token); ok {
		t.Fatal("disabled player remains signed in")
	}
	restarted, err = New(Config{CredentialStore: store})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := restarted.Login("old-player"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatal("disabled credential revived")
	}
}

func TestPasswordReviewRejectsStaleUnauthorizedAndInvalidChanges(t *testing.T) {
	t.Parallel()
	service, _ := New(Config{DMPassword: "dm-password", PlayerPassword: "player-password"})
	dm, _ := service.Login("dm-password")
	player, _ := service.Login("player-password")
	for _, test := range []struct {
		token, csrf, current string
		role                 Role
		password             string
		revision             int64
		want                 error
	}{
		{player.Token, player.CSRFToken, "dm-password", RoleDM, "new-dm", 1, ErrRoleTransition},
		{dm.Token, "wrong", "dm-password", RoleDM, "new-dm", 1, ErrRoleTransition},
		{dm.Token, dm.CSRFToken, "wrong", RoleDM, "new-dm", 1, ErrInvalidCredentials},
		{dm.Token, dm.CSRFToken, "dm-password", RoleDM, "", 1, ErrPasswordPolicy},
		{dm.Token, dm.CSRFToken, "dm-password", RolePlayer, "dm-password", 1, ErrPasswordPolicy},
		{dm.Token, dm.CSRFToken, "dm-password", RoleDM, "player-password", 1, ErrPasswordPolicy},
		{dm.Token, dm.CSRFToken, "dm-password", RoleDM, "new-dm", 0, ErrCredentialConflict},
	} {
		if _, err := service.ChangePassword(context.Background(), test.token, test.csrf, test.current, test.role, test.password, test.revision); !errors.Is(err, test.want) {
			t.Fatalf("error = %v, want %v", err, test.want)
		}
	}
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for range 2 {
		wg.Go(func() {
			_, err := service.ChangePassword(context.Background(), dm.Token, dm.CSRFToken, "dm-password", RolePlayer, "new-player", 1)
			results <- err
		})
	}
	wg.Wait()
	close(results)
	success, conflict := 0, 0
	for err := range results {
		if err == nil {
			success++
		} else if errors.Is(err, ErrCredentialConflict) {
			conflict++
		} else {
			t.Fatal(err)
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatalf("concurrent changes = %d success, %d conflict", success, conflict)
	}
}
