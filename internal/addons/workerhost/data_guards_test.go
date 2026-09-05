package workerhost

import (
	"context"
	"github.com/pjunak/ttrpg-codex/internal/application/addondata"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/addondatastore"
	"github.com/pjunak/ttrpg-codex/sdk/go/workerrpc"
	"testing"
)

func TestWorkerDataRevisionGuards(t *testing.T) {
	zero := int64(0)
	data := &dataStub{queryResult: addondata.QueryResult{DataRevision: &zero}}
	dispatcher := testDispatcher(t, data, "dm")
	result := call(t, dispatcher, "host/data.query", `{"contractVersion":"host-data-query.v1","kind":"collection","dataId":"notes","limit":1,"where":[],"includeDataRevision":true,"expectedDataRevision":0}`)
	assertJSONEqual(t, result, `{"contractVersion":"host-data-query-result.v1","documents":[],"dataRevision":0}`)
	if !data.query.IncludeDataRevision || data.query.ExpectedDataRevision == nil || *data.query.ExpectedDataRevision != 0 {
		t.Fatal("query revision not forwarded")
	}
	for _, guard := range []struct{ body, kind string }{
		{`{"kind":"collection","dataId":"foreign","revision":0}`, workerrpc.KindUnauthorized},
		{`{"kind":"collection","dataId":"notes"}`, workerrpc.KindValidationFailed},
		{`{"kind":"collection","dataId":"notes","revision":-1}`, workerrpc.KindValidationFailed},
		{`{"kind":"collection","dataId":"notes","revision":0},{"kind":"collection","dataId":"notes","revision":0}`, workerrpc.KindValidationFailed},
	} {
		before := data.calls
		_, err := dispatcher.HandleRPC(context.Background(), rpcRequest("host/data.transact", `{"contractVersion":"host-data-transaction.v1","mutations":[{"operation":"delete","kind":"collection","dataId":"notes","key":"n1","expectedRevision":1}],"expectedDataSets":[`+guard.body+`]}`))
		assertRPCError(t, err, guard.kind)
		if data.calls != before {
			t.Fatal("invalid guard reached data service")
		}
	}
	data.err = addondatastore.ErrConflict
	_, err := dispatcher.HandleRPC(context.Background(), rpcRequest("host/data.transact", `{"contractVersion":"host-data-transaction.v1","mutations":[{"operation":"delete","kind":"collection","dataId":"notes","key":"n1","expectedRevision":1}],"expectedDataSets":[{"kind":"collection","dataId":"notes","revision":0}]}`))
	assertRPCError(t, err, workerrpc.KindConflict)
	if len(data.transaction.ExpectedDataSets) != 1 || data.transaction.ExpectedDataSets[0].Revision != 0 {
		t.Fatal("write guard not forwarded")
	}
}
