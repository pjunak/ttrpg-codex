package httpapi

import (
	"github.com/pjunak/ttrpg-codex/internal/application/addondata"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAddonDataRevisionWireFields(t *testing.T) {
	zero := int64(0)
	stub := &addonDataStub{query: addondata.QueryResult{DataRevision: &zero}}
	handler := addonDataHandler(t, stub, func(*http.Request, bool) (addondata.Role, string, error) { return addondata.RoleDM, "dm", nil })
	query := httptest.NewRecorder()
	handler.ServeHTTP(query, addonJSONRequest(t, addonDataURL("query"), `{"contractVersion":"addon-data-query.v1","kind":"collection","dataId":"notes","limit":1,"where":[],"includeDataRevision":true,"expectedDataRevision":0}`))
	if query.Code != 200 || !strings.Contains(query.Body.String(), `"dataRevision":0`) || !stub.queryRequest.IncludeDataRevision || stub.queryRequest.ExpectedDataRevision == nil || *stub.queryRequest.ExpectedDataRevision != 0 {
		t.Fatalf("query guard lost: %d %s %+v", query.Code, query.Body, stub.queryRequest)
	}
	for _, guard := range []string{`{"kind":"collection","dataId":"notes","revision":0}`, `{"kind":"collection","dataId":"notes"}`} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, addonJSONRequest(t, addonDataURL("transactions"), `{"contractVersion":"addon-data-transaction.v1","mutations":[{"operation":"delete","kind":"collection","dataId":"notes","key":"n1","expectedRevision":1}],"expectedDataSets":[`+guard+`]}`))
		if strings.Contains(guard, "revision") {
			if response.Code != 200 || len(stub.transaction.ExpectedDataSets) != 1 || stub.transaction.ExpectedDataSets[0].Revision != 0 {
				t.Fatalf("write guard lost: %d %+v", response.Code, stub.transaction)
			}
		} else if response.Code != 400 {
			t.Fatalf("missing revision accepted: %d", response.Code)
		}
	}
}
