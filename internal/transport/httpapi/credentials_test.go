package httpapi

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
)

func TestPasswordRoutesRequireDMReviewAndNeverReturnSecrets(t *testing.T) {
	t.Parallel()
	service := testAuthService(t)
	handler, err := New(Config{Authentication: service})
	if err != nil {
		t.Fatal(err)
	}
	dm, _ := service.Login("dragon-master")
	player, _ := service.Login("party-member")
	cookie := "edit_session=" + dm.Token
	for _, cookie := range []string{"", "edit_session=" + player.Token} {
		if result := serveAuthRequest(handler, http.MethodGet, "/api/passwords", "", cookie, ""); result.Code != http.StatusForbidden {
			t.Fatalf("unauthorized status = %d", result.Code)
		}
	}
	status := serveAuthRequest(handler, http.MethodGet, "/api/passwords", "", cookie, "")
	if status.Code != 200 || status.Header().Get("Cache-Control") != "no-store" || strings.Contains(status.Body.String(), "dragon-master") || strings.Contains(status.Body.String(), "digest") {
		t.Fatal("invalid public status")
	}
	body := fmt.Sprintf(`{"role":"dm","currentPassword":"dragon-master","newPassword":"new-master","expectedRevision":%d}`, 1)
	if result := serveAuthRequest(handler, http.MethodPost, "/api/passwords", body, cookie, ""); result.Code != http.StatusForbidden {
		t.Fatal("missing CSRF accepted")
	}
	if result := serveAuthRequest(handler, http.MethodPost, "/api/passwords", strings.Replace(body, "dragon-master", "incorrect", 1), cookie, dm.CSRFToken); result.Code != http.StatusUnauthorized {
		t.Fatal("wrong current password accepted")
	}
	changed := serveAuthRequest(handler, http.MethodPost, "/api/passwords", body, cookie, dm.CSRFToken)
	if changed.Code != http.StatusOK || strings.Contains(changed.Body.String(), "new-master") || !strings.Contains(changed.Body.String(), `"revision":2`) {
		t.Fatalf("change = %d, %s", changed.Code, changed.Body.String())
	}
	if stale := serveAuthRequest(handler, http.MethodPost, "/api/passwords", body, cookie, dm.CSRFToken); stale.Code != http.StatusConflict {
		t.Fatal("stale review accepted")
	}
	if _, ok := service.Resolve(dm.Token); !ok {
		t.Fatal("reviewing session was lost")
	}
	projected, _ := service.SwitchRole(dm.Token, "player")
	if result := serveAuthRequest(handler, http.MethodGet, "/api/passwords", "", "edit_session="+projected.Token, ""); result.Code != http.StatusForbidden {
		t.Fatal("DM in player projection read password status")
	}
}
