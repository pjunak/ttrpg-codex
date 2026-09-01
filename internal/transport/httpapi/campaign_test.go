package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/pjunak/ttrpg-codex/internal/application/campaigndata"
	sessionauth "github.com/pjunak/ttrpg-codex/internal/auth"
	"github.com/pjunak/ttrpg-codex/internal/domain/campaign"
)

func TestCampaignDatasetUsesPublicProjectionForAnonymousAndPlayer(t *testing.T) {
	t.Parallel()
	source := &recordingCampaignData{dataset: campaigndata.Dataset{
		ContractVersion: campaigndata.ContractVersion,
		Collections: []campaigndata.CollectionView{{
			Name: campaign.Characters, Shape: campaign.List, Records: []campaigndata.RecordView{},
		}},
	}}
	handler := campaignHandler(t, source)

	for _, test := range []struct {
		name  string
		actor *sessionauth.Actor
	}{
		{name: "anonymous"},
		{name: "player", actor: &sessionauth.Actor{
			SessionID: "player-session", RealRole: sessionauth.RolePlayer, Role: sessionauth.RolePlayer,
		}},
		{name: "DM viewing as player", actor: &sessionauth.Actor{
			SessionID: "dm-session", RealRole: sessionauth.RoleDM, Role: sessionauth.RolePlayer,
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "/api/campaign", nil)
			if test.actor != nil {
				request = request.WithContext(sessionauth.WithActor(request.Context(), *test.actor))
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), campaigndata.ContractVersion) {
				t.Fatalf("response = %d %s", response.Code, response.Body.String())
			}
			if got := source.roles[len(source.roles)-1]; got != campaigndata.ViewPublic {
				t.Fatalf("role = %s", got)
			}
		})
	}
}

func TestCampaignDatasetUsesEffectiveDMProjection(t *testing.T) {
	t.Parallel()
	source := &recordingCampaignData{dataset: campaigndata.Dataset{
		ContractVersion: campaigndata.ContractVersion, Collections: []campaigndata.CollectionView{},
	}}
	handler := campaignHandler(t, source)
	request := httptest.NewRequest(http.MethodGet, "/api/campaign", nil)
	request = request.WithContext(sessionauth.WithActor(request.Context(), sessionauth.Actor{
		SessionID: "dm-session", RealRole: sessionauth.RoleDM, Role: sessionauth.RoleDM,
	}))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || len(source.roles) != 1 || source.roles[0] != campaigndata.ViewDM {
		t.Fatalf("response = %d %s; roles = %v", response.Code, response.Body.String(), source.roles)
	}
}

func TestCampaignDatasetRejectsQueriesAndContainsServiceFailures(t *testing.T) {
	t.Parallel()
	source := &recordingCampaignData{err: errors.New("database failed")}
	handler := campaignHandler(t, source)

	query := httptest.NewRecorder()
	handler.ServeHTTP(query, httptest.NewRequest(http.MethodGet, "/api/campaign?role=dm", nil))
	if query.Code != http.StatusBadRequest || len(source.roles) != 0 {
		t.Fatalf("query response = %d %s", query.Code, query.Body.String())
	}

	failure := httptest.NewRecorder()
	handler.ServeHTTP(failure, httptest.NewRequest(http.MethodGet, "/api/campaign", nil))
	if failure.Code != http.StatusServiceUnavailable ||
		!strings.Contains(failure.Body.String(), `"kind":"CAMPAIGN_UNAVAILABLE"`) ||
		strings.Contains(failure.Body.String(), "database failed") {
		t.Fatalf("failure response = %d %s", failure.Code, failure.Body.String())
	}
}

type recordingCampaignData struct {
	dataset campaigndata.Dataset
	err     error
	roles   []campaigndata.ViewRole
}

func (source *recordingCampaignData) Dataset(
	_ context.Context,
	role campaigndata.ViewRole,
) (campaigndata.Dataset, error) {
	source.roles = append(source.roles, role)
	return source.dataset, source.err
}

func campaignHandler(t *testing.T, source CampaignData) http.Handler {
	t.Helper()
	handler, err := New(Config{
		Version: "test", Logger: slog.New(slog.NewTextHandler(&strings.Builder{}, nil)),
		CampaignData: source,
	})
	if err != nil {
		t.Fatal(err)
	}
	return handler
}
