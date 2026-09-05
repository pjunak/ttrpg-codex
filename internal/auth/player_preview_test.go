package auth

import (
	"errors"
	"sync"
	"testing"
	"time"
)

func TestPlayerPreviewKeepsDMAndBindsPlayerLifetime(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 9, 5, 12, 0, 0, 0, time.UTC)
	service, err := New(Config{DMPassword: "dragon-master", Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	dm, _ := service.Login("dragon-master")
	preview, err := service.CreatePlayerPreview(dm.Token)
	if err != nil {
		t.Fatal(err)
	}
	if preview.Actor.Role != RolePlayer || preview.Actor.RealRole != RolePlayer || preview.Token == dm.Token ||
		preview.CSRFToken == dm.CSRFToken || preview.ExpiresAt != now.Add(time.Hour) {
		t.Fatal("preview did not get independent bounded player authority")
	}
	if current, ok := service.Inspect(dm.Token); !ok || current.Actor != dm.Actor {
		t.Fatal("preview changed the DM")
	}
	if !service.ValidateCSRF(preview.Token, preview.CSRFToken) || service.ValidateCSRF(preview.Token, dm.CSRFToken) {
		t.Fatal("preview CSRF is not isolated")
	}
	if _, ok := service.InspectPlayerPreview(dm.Token); ok {
		t.Fatal("ordinary DM token accepted as preview")
	}
	if _, err := service.SwitchRole(preview.Token, RoleDM); !errors.Is(err, ErrRoleTransition) {
		t.Fatal("preview became DM")
	}
	if _, err := service.CreatePlayerPreview(preview.Token); !errors.Is(err, ErrRoleTransition) {
		t.Fatal("preview created another preview")
	}
	now = now.Add(time.Hour)
	if _, ok := service.InspectPlayerPreview(preview.Token); ok {
		t.Fatal("expired preview survived")
	}
	if _, ok := service.Inspect(dm.Token); !ok {
		t.Fatal("preview expiry ended DM session")
	}
}

func TestPlayerPreviewRevocationRotationCapacityAndShortParent(t *testing.T) {
	t.Parallel()
	for _, transition := range []string{"revoke-preview", "revoke-parent", "rotate-parent", "expire-parent"} {
		t.Run(transition, func(t *testing.T) {
			now := time.Date(2026, 9, 5, 12, 0, 0, 0, time.UTC)
			service, _ := New(Config{DMPassword: "dragon-master", SessionTTL: 5 * time.Minute, Now: func() time.Time { return now }})
			dm, _ := service.Login("dragon-master")
			preview, err := service.CreatePlayerPreview(dm.Token)
			if err != nil || preview.ExpiresAt != dm.ExpiresAt {
				t.Fatal("preview outlived short parent", err)
			}
			switch transition {
			case "revoke-preview":
				service.Revoke(preview.Token)
			case "revoke-parent":
				service.Revoke(dm.Token)
			case "rotate-parent":
				if _, err := service.SwitchRole(dm.Token, RolePlayer); err != nil {
					t.Fatal(err)
				}
			case "expire-parent":
				now = now.Add(5 * time.Minute)
			}
			if _, ok := service.InspectPlayerPreview(preview.Token); ok {
				t.Fatal("preview survived revocation")
			}
			if _, ok := service.Resolve(preview.Token); ok || service.ValidateCSRF(preview.Token, preview.CSRFToken) {
				t.Fatal("revoked preview retained authority")
			}
			if transition == "revoke-preview" {
				if _, ok := service.Resolve(dm.Token); !ok {
					t.Fatal("closing preview revoked DM")
				}
			}
		})
	}
	service, _ := New(Config{DMPassword: "dragon-master"})
	dm, _ := service.Login("dragon-master")
	var first Session
	for i := 0; i < maximumPlayerPreviews; i++ {
		preview, err := service.CreatePlayerPreview(dm.Token)
		if err != nil {
			t.Fatal(err)
		}
		first = preview
	}
	if _, err := service.CreatePlayerPreview(dm.Token); !errors.Is(err, ErrSessionCapacity) {
		t.Fatal("unbounded previews")
	}
	service.Revoke(first.Token)
	if _, err := service.CreatePlayerPreview(dm.Token); err != nil {
		t.Fatal("closing preview did not release capacity", err)
	}
}

func TestConcurrentPreviewCreationAndParentRevocation(t *testing.T) {
	t.Parallel()
	service, _ := New(Config{DMPassword: "dragon-master"})
	dm, _ := service.Login("dragon-master")
	var wg sync.WaitGroup
	for range 12 {
		wg.Go(func() {
			preview, err := service.CreatePlayerPreview(dm.Token)
			if err == nil {
				service.InspectPlayerPreview(preview.Token)
				service.ValidateCSRF(preview.Token, preview.CSRFToken)
			}
		})
	}
	service.Revoke(dm.Token)
	wg.Wait()
	service.mu.Lock()
	defer service.mu.Unlock()
	for _, record := range service.sessions {
		if service.usableLocked(record, time.Now()) {
			t.Fatal("revoked family remained usable")
		}
	}
}
