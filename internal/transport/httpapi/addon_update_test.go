package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"github.com/pjunak/ttrpg-codex/internal/addons/datalifecycle"
	"github.com/pjunak/ttrpg-codex/internal/addons/packagemanager"
)

type recordingUpdate struct {
	recordingLifecycle
	calls int
	input packagemanager.UpdateResolution
	err   error
}

func (s *recordingUpdate) PrepareUpdateDataReview(context.Context, string) (datalifecycle.SchemaReview, error) {
	s.calls++
	return datalifecycle.SchemaReview{ForActivation: true}, s.err
}
func (s *recordingUpdate) ResolveAndActivate(_ context.Context, _ string, input packagemanager.UpdateResolution) (packagemanager.ActivationResult, error) {
	s.calls++
	s.input = input
	return packagemanager.ActivationResult{}, s.err
}
func (s *recordingUpdate) CancelActivationReview(context.Context, string) error {
	s.calls++
	return s.err
}

func TestAddonUpdateRequiresAuthorizationAndExactConfirmation(t *testing.T) {
	lifecycle := &recordingUpdate{}
	denied := newAdminHandler(t, lifecycle, func(*http.Request) error { return errors.New("denied") })
	allowed := newAdminHandler(t, lifecycle, func(*http.Request) error { return nil })
	for _, operation := range []string{"saved-data", "resolve", "cancel"} {
		path := "/api/admin/addon-activation-reviews/exact-review/update/" + operation
		if response := serveAdminRequest(denied, "POST", path, "invalid JSON"); response.Code != 403 || lifecycle.calls != 0 {
			t.Fatal(response.Code, lifecycle.calls)
		}
		if response := serveAdminRequest(allowed, "POST", path, `{"unreviewed":true}`); response.Code != 400 || lifecycle.calls != 0 {
			t.Fatal(response.Code, lifecycle.calls)
		}
	}
	input := packagemanager.UpdateResolution{ProposalSHA256: strings.Repeat("a", 64), SchemaReviewID: "data-review", SchemaReviewSHA256: strings.Repeat("b", 64), Action: "remove", GrantedPermissionIDs: []string{"core.data.read"}}
	raw, _ := json.Marshal(input)
	path := "/api/admin/addon-activation-reviews/exact-review/update/resolve"
	if response := serveAdminRequest(allowed, "POST", path, string(raw)); response.Code != 200 || !reflect.DeepEqual(lifecycle.input, input) {
		t.Fatal(response.Code, lifecycle.input)
	}
	lifecycle.err = packagemanager.ErrUpdateRestored
	if response := serveAdminRequest(allowed, "POST", path, string(raw)); response.Code != 409 || !strings.Contains(response.Body.String(), "UPDATE_RESTORED") {
		t.Fatal(response.Code, response.Body.String())
	}
	input.Action = "guess-values"
	raw, _ = json.Marshal(input)
	before := lifecycle.calls
	if response := serveAdminRequest(allowed, "POST", path, string(raw)); response.Code != 400 || lifecycle.calls != before {
		t.Fatal(response.Code, lifecycle.calls)
	}
}
