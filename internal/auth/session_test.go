package auth

import (
	"errors"
	"fmt"
	"testing"
	"time"
)

func TestServiceAuthenticatesAndExpiresOpaqueSessions(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, time.August, 31, 12, 0, 0, 0, time.UTC)
	sequence := 0
	service, err := New(Config{
		DMPassword: "dragon-master", PlayerPassword: "party-member",
		SessionTTL: time.Hour, Now: func() time.Time { return now },
		GenerateToken: func() (string, error) {
			sequence++
			return fmt.Sprintf("token_%026d", sequence), nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Login("wrong"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("wrong password error = %v", err)
	}
	dm, err := service.Login("dragon-master")
	if err != nil {
		t.Fatal(err)
	}
	if dm.Actor.RealRole != RoleDM || dm.Actor.Role != RoleDM || dm.Actor.SessionID == "" {
		t.Fatalf("DM actor = %+v", dm.Actor)
	}
	if actor, ok := service.Resolve(dm.Token); !ok || actor != dm.Actor {
		t.Fatalf("resolved actor = %+v, %v", actor, ok)
	}
	if inspected, ok := service.Inspect(dm.Token); !ok || inspected.CSRFToken != dm.CSRFToken {
		t.Fatalf("inspected session = %+v, %v", inspected, ok)
	}
	if !service.ValidateCSRF(dm.Token, dm.CSRFToken) || service.ValidateCSRF(dm.Token, dm.Token) {
		t.Fatal("CSRF binding did not match the exact session token pair")
	}
	player, err := service.Login("party-member")
	if err != nil || player.Actor.RealRole != RolePlayer || player.Actor.Role != RolePlayer {
		t.Fatalf("player login = %+v, %v", player, err)
	}

	now = now.Add(time.Hour)
	if _, ok := service.Resolve(dm.Token); ok || service.ValidateCSRF(dm.Token, dm.CSRFToken) {
		t.Fatal("expired session retained authority")
	}
}

func TestServiceRotatesSessionAcrossDMRoleTransitions(t *testing.T) {
	t.Parallel()
	sequence := 0
	service, err := New(Config{
		DMPassword: "dragon-master",
		GenerateToken: func() (string, error) {
			sequence++
			return fmt.Sprintf("token_%026d", sequence), nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	dm, err := service.Login("dragon-master")
	if err != nil {
		t.Fatal(err)
	}
	playerView, err := service.SwitchRole(dm.Token, RolePlayer)
	if err != nil {
		t.Fatal(err)
	}
	if playerView.Token == dm.Token || playerView.CSRFToken == dm.CSRFToken ||
		playerView.Actor.RealRole != RoleDM || playerView.Actor.Role != RolePlayer {
		t.Fatalf("player view session = %+v", playerView)
	}
	if _, ok := service.Resolve(dm.Token); ok {
		t.Fatal("role switch left the previous session usable")
	}
	restored, err := service.SwitchRole(playerView.Token, RoleDM)
	if err != nil || restored.Actor.Role != RoleDM {
		t.Fatalf("restored session = %+v, %v", restored, err)
	}
	player, err := service.Login("dragon-master")
	if err != nil {
		t.Fatal(err)
	}
	service.Revoke(player.Token)
	if _, ok := service.Resolve(player.Token); ok {
		t.Fatal("revoked session retained authority")
	}
}

func TestServiceBoundsSessionCapacity(t *testing.T) {
	t.Parallel()
	sequence := 0
	service, err := New(Config{
		DMPassword: "dragon-master", MaxSessions: 1,
		GenerateToken: func() (string, error) {
			sequence++
			return fmt.Sprintf("token_%026d", sequence), nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Login("dragon-master"); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Login("dragon-master"); !errors.Is(err, ErrSessionCapacity) {
		t.Fatalf("capacity error = %v", err)
	}
}
