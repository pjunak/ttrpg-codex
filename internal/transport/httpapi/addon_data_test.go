package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/addons/datacontract"
	"github.com/pjunak/ttrpg-codex/internal/application/addondata"
	sessionauth "github.com/pjunak/ttrpg-codex/internal/auth"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/addondatastore"
)

const httpGeneration = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func TestAddonDataConfigurationFailsClosed(t *testing.T) {
	t.Parallel()
	allow := AddonDataAuthorizer(func(*http.Request, bool) (addondata.Role, string, error) {
		return addondata.RoleDM, "dm", nil
	})
	if _, err := New(Config{AddonData: &addonDataStub{}}); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("data without authorizer error = %v", err)
	}
	if _, err := New(Config{AddonDataAuthorizer: allow}); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("authorizer without data error = %v", err)
	}
}

func TestAddonDataAuthorizesBeforeParsingAndBindsGeneration(t *testing.T) {
	t.Parallel()
	stub := &addonDataStub{}
	handler := addonDataHandler(t, stub, func(*http.Request, bool) (addondata.Role, string, error) {
		return "", "", errAuthorizationRequired
	})
	request := httptest.NewRequest(http.MethodPost, addonDataURL("get"), strings.NewReader("not-json"))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden || stub.calls != 0 {
		t.Fatalf("denied response = %d %s, calls %d", response.Code, response.Body.String(), stub.calls)
	}

	stub.document = addondatastore.Document{Key: "n1", Revision: 3, Value: json.RawMessage(`{"id":"n1"}`)}
	handler = addonDataHandler(t, stub, func(_ *http.Request, write bool) (addondata.Role, string, error) {
		if write {
			t.Fatal("get was authorized as a write")
		}
		return addondata.RolePlayer, "session:p1", nil
	})
	request = addonJSONRequest(t, addonDataURL("get"), `{
		"contractVersion":"addon-data-get.v1","kind":"collection","dataId":"notes","key":"n1"
	}`)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"contractVersion":"addon-data-document.v1"`) ||
		!strings.Contains(response.Body.String(), `"value":{"id":"n1"}`) {
		t.Fatalf("get response = %d %s", response.Code, response.Body.String())
	}
	if stub.access.AddonID != "dm-tools" || stub.access.Generation != httpGeneration ||
		stub.access.Role != addondata.RolePlayer || stub.access.ActorID != "session:p1" {
		t.Fatalf("bound access = %+v", stub.access)
	}
}

func TestAddonDataQueryAndTransactionUseBoundedWireContracts(t *testing.T) {
	t.Parallel()
	next := int64(7)
	stub := &addonDataStub{
		query: addondata.QueryResult{
			Documents:    []addondatastore.Document{{Key: "n1", Revision: 2, Value: json.RawMessage(`{"id":"n1"}`)}},
			NextPosition: &next,
		},
		commit: addondatastore.Commit{
			ID: 9, OccurredAt: time.Date(2026, time.September, 1, 12, 0, 0, 0, time.UTC),
			Results: []addondatastore.MutationResult{{
				Kind: datacontract.Collection, DataID: "notes", Key: "n1",
				BeforeRevision: 1, AfterRevision: 2,
			}},
			DataRevisions: map[string]int64{"collection\x00notes": 4},
		},
	}
	writes := make([]bool, 0, 2)
	handler := addonDataHandler(t, stub, func(_ *http.Request, write bool) (addondata.Role, string, error) {
		writes = append(writes, write)
		return addondata.RoleDM, "session:dm", nil
	})
	query := addonJSONRequest(t, addonDataURL("query"), `{
		"contractVersion":"addon-data-query.v1","kind":"collection","dataId":"notes",
		"limit":10,"where":[{"path":"/type","equals":"clue"}]
	}`)
	queryResponse := httptest.NewRecorder()
	handler.ServeHTTP(queryResponse, query)
	if queryResponse.Code != http.StatusOK ||
		!strings.Contains(queryResponse.Body.String(), `"contractVersion":"addon-data-query-result.v1"`) ||
		!strings.Contains(queryResponse.Body.String(), `"nextCursor":"Nw"`) {
		t.Fatalf("query response = %d %s", queryResponse.Code, queryResponse.Body.String())
	}
	if stub.queryRequest.AfterPosition != -1 || len(stub.queryRequest.Where) != 1 {
		t.Fatalf("query request = %+v", stub.queryRequest)
	}

	transaction := addonJSONRequest(t, addonDataURL("transactions"), `{
		"contractVersion":"addon-data-transaction.v1","mutations":[{
			"operation":"put","kind":"collection","dataId":"notes","key":"n1",
			"expectedRevision":1,"value":{"id":"n1"}
		}]
	}`)
	transactionResponse := httptest.NewRecorder()
	handler.ServeHTTP(transactionResponse, transaction)
	if transactionResponse.Code != http.StatusOK ||
		!strings.Contains(transactionResponse.Body.String(), `"contractVersion":"addon-data-commit.v1"`) ||
		!strings.Contains(transactionResponse.Body.String(), `"revision":4`) ||
		strings.Contains(transactionResponse.Body.String(), "\\u0000") {
		t.Fatalf("transaction response = %d %s", transactionResponse.Code, transactionResponse.Body.String())
	}
	if len(writes) != 2 || writes[0] || !writes[1] {
		t.Fatalf("authorization modes = %v", writes)
	}
}

func TestSessionAddonDataAuthorizerRequiresCSRFOnlyForWrites(t *testing.T) {
	t.Parallel()
	authentication, err := sessionauth.New(sessionauth.Config{DMPassword: "dm-password"})
	if err != nil {
		t.Fatal(err)
	}
	session, err := authentication.Login("dm-password")
	if err != nil {
		t.Fatal(err)
	}
	authorize := SessionAddonDataAuthorizer(authentication)
	request := httptest.NewRequest(http.MethodPost, addonDataURL("query"), nil)
	request = request.WithContext(sessionauth.WithActor(request.Context(), session.Actor))
	request.AddCookie(&http.Cookie{Name: sessionCookieName, Value: session.Token})
	role, actorID, err := authorize(request, false)
	if err != nil || role != addondata.RoleDM || actorID != "session:"+session.Actor.SessionID {
		t.Fatalf("read authority = %s %s, %v", role, actorID, err)
	}
	if _, _, err := authorize(request, true); err == nil {
		t.Fatal("write without CSRF was authorized")
	}
	request.Header.Set(csrfHeaderName, session.CSRFToken)
	if _, _, err := authorize(request, true); err != nil {
		t.Fatalf("write with CSRF error = %v", err)
	}
}

type addonDataStub struct {
	calls        int
	access       addondata.Access
	document     addondatastore.Document
	query        addondata.QueryResult
	queryRequest addondata.Query
	commit       addondatastore.Commit
	err          error
}

func (stub *addonDataStub) Get(
	_ context.Context, access addondata.Access, _ datacontract.Kind, _, _ string,
) (addondatastore.Document, error) {
	stub.calls++
	stub.access = access
	return stub.document, stub.err
}

func (stub *addonDataStub) Query(_ context.Context, query addondata.Query) (addondata.QueryResult, error) {
	stub.calls++
	stub.access = query.Access
	stub.queryRequest = query
	return stub.query, stub.err
}

func (stub *addonDataStub) Transact(
	_ context.Context, transaction addondata.Transaction,
) (addondatastore.Commit, error) {
	stub.calls++
	stub.access = transaction.Access
	return stub.commit, stub.err
}

func addonDataHandler(t *testing.T, data AddonData, authorize AddonDataAuthorizer) http.Handler {
	t.Helper()
	handler, err := New(Config{
		AddonData: data, AddonDataAuthorizer: authorize,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	return handler
}

func addonDataURL(operation string) string {
	return "/api/addons/dm-tools/generations/" + httpGeneration + "/data/" + operation
}

func addonJSONRequest(t *testing.T, url, body string) *http.Request {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, url, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	return request
}
