package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/recoverystore"
)

type recordingRecovery struct {
	calls int
	err   error
	actor string
}

func (r *recordingRecovery) List(context.Context) (recoverystore.Listing, error) {
	r.calls++
	return recoverystore.Listing{ContractVersion: "recovery-points.v1", Points: []recoverystore.Point{}}, r.err
}
func (r *recordingRecovery) Create(context.Context) error               { r.calls++; return r.err }
func (r *recordingRecovery) Delete(context.Context, int64, int64) error { r.calls++; return r.err }
func (r *recordingRecovery) Restore(_ context.Context, _ recoverystore.RestoreRequest, actor string) error {
	r.calls++
	r.actor = actor
	return r.err
}

func TestRecoveryRequiresRealDMAndCSRF(t *testing.T) {
	service := testAuthService(t)
	recovery := &recordingRecovery{}
	if _, err := New(Config{RecoveryPoints: recovery}); !errors.Is(err, ErrInvalidConfig) {
		t.Fatal("recovery registered without authentication")
	}
	handler, err := New(Config{Authentication: service, RecoveryPoints: recovery})
	if err != nil {
		t.Fatal(err)
	}
	dm, _ := service.Login("dragon-master")
	player, _ := service.Login("party-member")
	for _, cookie := range []string{"", "edit_session=" + player.Token} {
		for _, method := range []string{http.MethodGet, http.MethodPost} {
			if result := serveAuthRequest(handler, method, "/api/recovery", "{}", cookie, dm.CSRFToken); result.Code != 403 {
				t.Fatal("recovery exposed")
			}
		}
	}
	cookie := "edit_session=" + dm.Token
	for _, path := range []string{"/api/recovery", "/api/recovery/delete", "/api/recovery/restore"} {
		if result := serveAuthRequest(handler, http.MethodPost, path, "{}", cookie, ""); result.Code != 403 {
			t.Fatal("missing CSRF accepted")
		}
	}
	if recovery.calls != 0 {
		t.Fatal("unauthorized call reached storage")
	}
	result := serveAuthRequest(handler, http.MethodGet, "/api/recovery", "", cookie, "")
	if result.Code != 200 || result.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("invalid listing")
	}
	if result := serveAuthRequest(handler, http.MethodPost, "/api/recovery", `{"unexpected":true}`, cookie, dm.CSRFToken); result.Code != 400 {
		t.Fatal("unknown fields accepted")
	}
	result = serveAuthRequest(handler, http.MethodPost, "/api/recovery/restore", `{"id":1,"expectedRevision":3}`, cookie, dm.CSRFToken)
	if result.Code != 200 || recovery.actor != "session:"+dm.Actor.SessionID {
		t.Fatalf("server actor missing: %s", recovery.actor)
	}
	projected, _ := service.SwitchRole(dm.Token, "player")
	if result := serveAuthRequest(handler, http.MethodGet, "/api/recovery", "", "edit_session="+projected.Token, ""); result.Code != 403 {
		t.Fatal("player view exposed recovery")
	}
}

func TestRecoveryErrorsAreActionableWithoutLeakingPrivateData(t *testing.T) {
	service := testAuthService(t)
	recovery := &recordingRecovery{}
	handler, err := New(Config{Authentication: service, RecoveryPoints: recovery})
	if err != nil {
		t.Fatal(err)
	}
	dm, _ := service.Login("dragon-master")
	for _, tc := range []struct {
		err    error
		status int
		kind   string
	}{{recoverystore.ErrConflict, 409, "RECOVERY_CONFLICT"}, {recoverystore.ErrCompatibility, 409, "RECOVERY_COMPATIBILITY"}, {recoverystore.ErrNotFound, 404, "RECOVERY_NOT_FOUND"}, {errors.New("private path or campaign body"), 503, "RECOVERY_UNAVAILABLE"}} {
		recovery.err = tc.err
		result := serveAuthRequest(handler, http.MethodPost, "/api/recovery/restore", `{"id":1,"expectedRevision":3}`, "edit_session="+dm.Token, dm.CSRFToken)
		if result.Code != tc.status || !strings.Contains(result.Body.String(), tc.kind) || strings.Contains(result.Body.String(), "private path") {
			t.Fatalf("wrong recovery error: %s", result.Body.String())
		}
	}
}
