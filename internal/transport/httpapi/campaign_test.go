package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

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

func TestCampaignMutationConfigurationFailsClosed(t *testing.T) {
	t.Parallel()
	mutations := &recordingCampaignMutations{}
	writer := CampaignMutationAuthorizer(func(*http.Request) (campaigndata.MutationAuthority, error) {
		return campaigndata.MutationAuthority{ActorID: "dm", Role: campaigndata.WriteDM}, nil
	})
	if _, err := New(Config{CampaignMutations: mutations}); err != ErrInvalidConfig {
		t.Fatalf("mutations without writer error = %v", err)
	}
	if _, err := New(Config{CampaignWriter: writer}); err != ErrInvalidConfig {
		t.Fatalf("writer without mutations error = %v", err)
	}
}

func TestCampaignTransactionAuthorizesBeforeParsingAndReturnsBoundedReceipt(t *testing.T) {
	t.Parallel()
	mutations := &recordingCampaignMutations{commit: campaign.Commit{
		ID: 7, OccurredAt: time.Date(2026, time.September, 1, 12, 0, 0, 0, time.UTC),
		Results: []campaign.MutationResult{{
			Collection: campaign.Characters, Key: "alice",
			BeforeRevision: 2, AfterRevision: 3,
		}},
		CollectionRevisions: map[campaign.Collection]int64{campaign.Characters: 5},
	}}
	denied := campaignMutationHandler(t, mutations, func(*http.Request) (campaigndata.MutationAuthority, error) {
		return campaigndata.MutationAuthority{}, errAuthorizationRequired
	})
	response := httptest.NewRecorder()
	denied.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/campaign/transactions", strings.NewReader("not-json")))
	if response.Code != http.StatusForbidden || len(mutations.requests) != 0 {
		t.Fatalf("denied response = %d %s; calls = %d", response.Code, response.Body.String(), len(mutations.requests))
	}

	authority := campaigndata.MutationAuthority{ActorID: "session:player", Role: campaigndata.WritePlayer}
	allowed := campaignMutationHandler(t, mutations, func(*http.Request) (campaigndata.MutationAuthority, error) {
		return authority, nil
	})
	request := httptest.NewRequest(http.MethodPost, "/api/campaign/transactions", strings.NewReader(`{
		"contractVersion":"campaign-mutation.v1",
		"mutations":[{
			"operation":"put","collection":"characters","key":"alice",
			"expectedRevision":2,"value":{"id":"alice","name":"Alice"}
		}]
	}`))
	request.Header.Set("Content-Type", "application/json")
	response = httptest.NewRecorder()
	allowed.ServeHTTP(response, request)
	if response.Code != http.StatusOK ||
		!strings.Contains(response.Body.String(), `"contractVersion":"campaign-commit.v1"`) ||
		!strings.Contains(response.Body.String(), `"commitId":7`) {
		t.Fatalf("allowed response = %d %s", response.Code, response.Body.String())
	}
	if len(mutations.requests) != 1 || mutations.authorities[0] != authority ||
		mutations.requests[0][0].ExpectedRevision != 2 ||
		string(mutations.requests[0][0].Value) != `{"id":"alice","name":"Alice"}` {
		t.Fatalf("mutation call = %+v, %+v", mutations.authorities, mutations.requests)
	}
}

func TestCampaignTransactionMapsConflictsWithoutLeakingDerivedTarget(t *testing.T) {
	t.Parallel()
	mutations := &recordingCampaignMutations{err: &campaign.ConflictError{
		Collection: campaign.Characters, Key: "private-derived-record", Expected: 2, Actual: 3,
	}}
	handler := campaignMutationHandler(t, mutations, func(*http.Request) (campaigndata.MutationAuthority, error) {
		return campaigndata.MutationAuthority{ActorID: "session:player", Role: campaigndata.WritePlayer}, nil
	})
	request := httptest.NewRequest(http.MethodPost, "/api/campaign/transactions", strings.NewReader(`{
		"contractVersion":"campaign-mutation.v1",
		"mutations":[{"operation":"delete","collection":"pets","key":"owl","expectedRevision":2}]
	}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusConflict ||
		!strings.Contains(response.Body.String(), `"kind":"WRITE_CONFLICT"`) ||
		strings.Contains(response.Body.String(), "private-derived-record") {
		t.Fatalf("conflict response = %d %s", response.Code, response.Body.String())
	}
}

func TestSessionCampaignMutationAuthorizerRequiresBoundCSRFAndUsesEffectiveRole(t *testing.T) {
	t.Parallel()
	service, err := sessionauth.New(sessionauth.Config{
		DMPassword: "dragon-master", PlayerPassword: "party-member",
	})
	if err != nil {
		t.Fatal(err)
	}
	session, err := service.Login("dragon-master")
	if err != nil {
		t.Fatal(err)
	}
	authorize := SessionCampaignMutationAuthorizer(service)
	request := httptest.NewRequest(http.MethodPost, "/api/campaign/transactions", nil)
	request.AddCookie(&http.Cookie{Name: sessionCookieName, Value: session.Token})
	request = request.WithContext(sessionauth.WithActor(request.Context(), session.Actor))
	if _, err := authorize(request); !errors.Is(err, errAuthorizationRequired) {
		t.Fatalf("missing CSRF error = %v", err)
	}
	request.Header.Set(csrfHeaderName, session.CSRFToken)
	authority, err := authorize(request)
	if err != nil || authority.Role != campaigndata.WriteDM ||
		authority.ActorID != "session:"+session.Actor.SessionID {
		t.Fatalf("DM authority = %+v, %v", authority, err)
	}

	playerView, err := service.SwitchRole(session.Token, sessionauth.RolePlayer)
	if err != nil {
		t.Fatal(err)
	}
	request = httptest.NewRequest(http.MethodPost, "/api/campaign/transactions", nil)
	request.AddCookie(&http.Cookie{Name: sessionCookieName, Value: playerView.Token})
	request.Header.Set(csrfHeaderName, playerView.CSRFToken)
	request = request.WithContext(sessionauth.WithActor(request.Context(), playerView.Actor))
	authority, err = authorize(request)
	if err != nil || authority.Role != campaigndata.WritePlayer {
		t.Fatalf("DM-as-player authority = %+v, %v", authority, err)
	}
}

type recordingCampaignData struct {
	dataset campaigndata.Dataset
	err     error
	roles   []campaigndata.ViewRole
}

type recordingCampaignMutations struct {
	commit      campaign.Commit
	err         error
	authorities []campaigndata.MutationAuthority
	requests    [][]campaign.Mutation
}

func (service *recordingCampaignMutations) Mutate(
	_ context.Context,
	authority campaigndata.MutationAuthority,
	mutations []campaign.Mutation,
) (campaign.Commit, error) {
	service.authorities = append(service.authorities, authority)
	service.requests = append(service.requests, mutations)
	return service.commit, service.err
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

func campaignMutationHandler(
	t *testing.T,
	mutations CampaignMutations,
	authorize CampaignMutationAuthorizer,
) http.Handler {
	t.Helper()
	handler, err := New(Config{
		Version: "test", Logger: slog.New(slog.NewTextHandler(&strings.Builder{}, nil)),
		CampaignMutations: mutations, CampaignWriter: authorize,
	})
	if err != nil {
		t.Fatal(err)
	}
	return handler
}
