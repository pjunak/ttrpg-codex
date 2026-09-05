package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strconv"

	"github.com/pjunak/ttrpg-codex/internal/addons/datacontract"
	"github.com/pjunak/ttrpg-codex/internal/application/addondata"
	sessionauth "github.com/pjunak/ttrpg-codex/internal/auth"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/addondatastore"
)

const (
	addonDataGetVersion         = "addon-data-get.v1"
	addonDataQueryVersion       = "addon-data-query.v1"
	addonDataTransactionVersion = "addon-data-transaction.v1"
	addonDataDocumentVersion    = "addon-data-document.v1"
	addonDataQueryResultVersion = "addon-data-query-result.v1"
	addonDataCommitVersion      = "addon-data-commit.v1"
	maximumAddonDataBody        = addondatastore.MaximumPayloadBytes + 128<<10
)

type AddonData interface {
	Get(context.Context, addondata.Access, datacontract.Kind, string, string) (addondatastore.Document, error)
	Query(context.Context, addondata.Query) (addondata.QueryResult, error)
	Transact(context.Context, addondata.Transaction) (addondatastore.Commit, error)
}

type AddonDataAuthorizer func(*http.Request, bool) (addondata.Role, string, error)

var _ AddonData = (*addondata.Service)(nil)

func SessionAddonDataAuthorizer(service *sessionauth.Service) AddonDataAuthorizer {
	return func(r *http.Request, write bool) (addondata.Role, string, error) {
		actor, ok := sessionauth.ActorFromContext(r.Context())
		if !ok || service == nil {
			return "", "", errAuthorizationRequired
		}
		if write && !service.ValidateCSRF(sessionToken(r), r.Header.Get(csrfHeaderName)) {
			return "", "", errAuthorizationRequired
		}
		role := addondata.RolePlayer
		if actor.Role == sessionauth.RoleDM {
			role = addondata.RoleDM
		}
		return role, "session:" + actor.SessionID, nil
	}
}

func (s *server) registerAddonDataRoutes(mux *http.ServeMux) {
	base := "/api/addons/{addonID}/generations/{generationID}/data/"
	mux.Handle("POST "+base+"get", s.requireAddonData(false, http.HandlerFunc(s.addonDataGet)))
	mux.Handle("POST "+base+"query", s.requireAddonData(false, http.HandlerFunc(s.addonDataQuery)))
	mux.Handle("POST "+base+"transactions", s.requireAddonData(true, http.HandlerFunc(s.addonDataTransaction)))
}

type addonDataAuthorityKey struct{}

func (s *server) requireAddonData(write bool, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		role, actorID, err := s.addonDataAuthorizer(r, write)
		if err != nil {
			s.logger.Warn("add-on data access denied", "method", r.Method, "path", r.URL.Path)
			writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "add-on data authorization is required")
			return
		}
		access, ok := addonDataAccess(w, r, role, actorID)
		if !ok {
			return
		}
		ctx := context.WithValue(r.Context(), addonDataAuthorityKey{}, access)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func addonDataAccess(
	w http.ResponseWriter,
	r *http.Request,
	role addondata.Role,
	actorID string,
) (addondata.Access, bool) {
	addonID, ok := pathResourceID(w, r, "addonID")
	if !ok {
		return addondata.Access{}, false
	}
	generation, ok := pathResourceID(w, r, "generationID")
	if !ok || !validAddonGeneration(generation) {
		if ok {
			writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "generationID is invalid")
		}
		return addondata.Access{}, false
	}
	return addondata.Access{AddonID: addonID, Generation: generation, Role: role, ActorID: actorID}, true
}

func validAddonGeneration(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, character := range value {
		if character < '0' || character > '9' {
			if character < 'a' || character > 'f' {
				return false
			}
		}
	}
	return true
}

func addonDataAccessFromContext(ctx context.Context) addondata.Access {
	access, _ := ctx.Value(addonDataAuthorityKey{}).(addondata.Access)
	return access
}

func (s *server) addonDataGet(w http.ResponseWriter, r *http.Request) {
	if r.URL.RawQuery != "" {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "query parameters are not supported")
		return
	}
	var request struct {
		ContractVersion string            `json:"contractVersion"`
		Kind            datacontract.Kind `json:"kind"`
		DataID          string            `json:"dataId"`
		Key             string            `json:"key"`
	}
	if !decodeBoundedJSON(w, r, &request, 8<<10, "add-on data get") {
		return
	}
	if request.ContractVersion != addonDataGetVersion {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "add-on data get contract is invalid")
		return
	}
	document, err := s.addonData.Get(
		r.Context(), addonDataAccessFromContext(r.Context()), request.Kind, request.DataID, request.Key,
	)
	if err != nil {
		s.writeAddonDataError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, addonDocumentResponse(addonDataDocumentVersion, document))
}

func (s *server) addonDataQuery(w http.ResponseWriter, r *http.Request) {
	if r.URL.RawQuery != "" {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "query parameters are not supported")
		return
	}
	var request struct {
		ContractVersion      string            `json:"contractVersion"`
		Kind                 datacontract.Kind `json:"kind"`
		DataID               string            `json:"dataId"`
		Cursor               string            `json:"cursor,omitempty"`
		IncludeDataRevision  bool              `json:"includeDataRevision,omitempty"`
		ExpectedDataRevision *int64            `json:"expectedDataRevision,omitempty"`
		Limit                int               `json:"limit"`
		Where                []struct {
			Path   string          `json:"path"`
			Equals json.RawMessage `json:"equals"`
		} `json:"where"`
	}
	if !decodeBoundedJSON(w, r, &request, 32<<10, "add-on data query") {
		return
	}
	after, err := decodeAddonDataCursor(request.Cursor)
	if request.ContractVersion != addonDataQueryVersion || err != nil {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "add-on data query contract is invalid")
		return
	}
	conditions := make([]addondata.QueryCondition, 0, len(request.Where))
	for _, condition := range request.Where {
		conditions = append(conditions, addondata.QueryCondition{
			Path: condition.Path, Equals: append(json.RawMessage(nil), condition.Equals...),
		})
	}
	result, err := s.addonData.Query(r.Context(), addondata.Query{
		Access: addonDataAccessFromContext(r.Context()), DataKind: request.Kind, DataID: request.DataID,
		AfterPosition: after, Limit: request.Limit, Where: conditions,
		IncludeDataRevision: request.IncludeDataRevision, ExpectedDataRevision: request.ExpectedDataRevision,
	})
	if err != nil {
		s.writeAddonDataError(w, r, err)
		return
	}
	documents := make([]map[string]any, 0, len(result.Documents))
	for _, document := range result.Documents {
		documents = append(documents, addonDocumentResponse("", document))
	}
	response := map[string]any{
		"contractVersion": addonDataQueryResultVersion,
		"documents":       documents,
	}
	if result.DataRevision != nil {
		response["dataRevision"] = *result.DataRevision
	}
	if result.NextPosition != nil {
		response["nextCursor"] = encodeAddonDataCursor(*result.NextPosition)
	}
	writeJSON(w, http.StatusOK, response)
}

func (s *server) addonDataTransaction(w http.ResponseWriter, r *http.Request) {
	if r.URL.RawQuery != "" {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "query parameters are not supported")
		return
	}
	var request struct {
		ContractVersion  string `json:"contractVersion"`
		ExpectedDataSets []struct {
			Kind     datacontract.Kind `json:"kind"`
			DataID   string            `json:"dataId"`
			Revision *int64            `json:"revision"`
		} `json:"expectedDataSets,omitempty"`
		Mutations []struct {
			Operation        addondatastore.OperationKind `json:"operation"`
			Kind             datacontract.Kind            `json:"kind"`
			DataID           string                       `json:"dataId"`
			Key              string                       `json:"key"`
			ExpectedRevision *int64                       `json:"expectedRevision"`
			Value            json.RawMessage              `json:"value,omitempty"`
		} `json:"mutations"`
	}
	if !decodeBoundedJSON(w, r, &request, maximumAddonDataBody, "add-on data transaction") {
		return
	}
	if request.ContractVersion != addonDataTransactionVersion || len(request.Mutations) == 0 ||
		len(request.Mutations) > addondatastore.MaximumOperations {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "add-on data transaction contract is invalid")
		return
	}
	guards := make([]addondatastore.DataSetRevision, 0, len(request.ExpectedDataSets))
	for _, guard := range request.ExpectedDataSets {
		if guard.Revision == nil {
			writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "data set revision is required")
			return
		}
		guards = append(guards, addondatastore.DataSetRevision{Kind: guard.Kind, DataID: guard.DataID, Revision: *guard.Revision})
	}
	mutations := make([]addondata.Mutation, 0, len(request.Mutations))
	for _, candidate := range request.Mutations {
		if candidate.ExpectedRevision == nil {
			writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "expectedRevision is required")
			return
		}
		mutations = append(mutations, addondata.Mutation{
			Kind: candidate.Operation, DataKind: candidate.Kind, DataID: candidate.DataID,
			Key: candidate.Key, ExpectedRevision: *candidate.ExpectedRevision,
			Value: append(json.RawMessage(nil), candidate.Value...),
		})
	}
	commit, err := s.addonData.Transact(r.Context(), addondata.Transaction{
		Access: addonDataAccessFromContext(r.Context()), Mutations: mutations, ExpectedDataSets: guards,
	})
	if err != nil {
		s.writeAddonDataError(w, r, err)
		return
	}
	results := make([]map[string]any, 0, len(commit.Results))
	sets := make(map[string]map[string]any)
	for _, result := range commit.Results {
		results = append(results, map[string]any{
			"kind": result.Kind, "dataId": result.DataID, "key": result.Key,
			"beforeRevision": result.BeforeRevision, "afterRevision": result.AfterRevision,
			"deleted": result.Deleted,
		})
		identity := string(result.Kind) + "\x00" + result.DataID
		sets[identity] = map[string]any{
			"kind": result.Kind, "dataId": result.DataID, "revision": commit.DataRevisions[identity],
		}
	}
	identities := make([]string, 0, len(sets))
	for identity := range sets {
		identities = append(identities, identity)
	}
	sort.Strings(identities)
	dataSets := make([]map[string]any, 0, len(identities))
	for _, identity := range identities {
		dataSets = append(dataSets, sets[identity])
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"contractVersion": addonDataCommitVersion, "commitId": commit.ID,
		"occurredAt": commit.OccurredAt, "results": results, "dataSets": dataSets,
	})
}

func addonDocumentResponse(contractVersion string, document addondatastore.Document) map[string]any {
	result := map[string]any{
		"key": document.Key, "revision": document.Revision,
		"value": json.RawMessage(append([]byte(nil), document.Value...)),
	}
	if contractVersion != "" {
		result["contractVersion"] = contractVersion
	}
	return result
}

func encodeAddonDataCursor(position int64) string {
	return base64.RawURLEncoding.EncodeToString([]byte(strconv.FormatInt(position, 10)))
}

func decodeAddonDataCursor(value string) (int64, error) {
	if value == "" {
		return -1, nil
	}
	if len(value) > 32 {
		return 0, ErrInvalidConfig
	}
	body, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return 0, err
	}
	position, err := strconv.ParseInt(string(body), 10, 64)
	if err != nil || position < 0 || encodeAddonDataCursor(position) != value {
		return 0, ErrInvalidConfig
	}
	return position, nil
}

func (s *server) writeAddonDataError(w http.ResponseWriter, r *http.Request, err error) {
	status, kind, message := http.StatusServiceUnavailable, "ADDON_DATA_UNAVAILABLE", "add-on data is unavailable"
	switch {
	case errors.Is(err, addondata.ErrUnauthorized):
		status, kind, message = http.StatusForbidden, "FORBIDDEN", "add-on data access is not allowed"
	case errors.Is(err, addondata.ErrInactiveGeneration):
		status, kind, message = http.StatusConflict, "STALE_GENERATION", "the add-on generation is no longer active"
	case errors.Is(err, addondatastore.ErrNotFound), errors.Is(err, addondata.ErrTargetNotFound), errors.Is(err, addondata.ErrTargetReplaced):
		status, kind, message = http.StatusNotFound, "NOT_FOUND", "the add-on document or target was not found"
	case errors.Is(err, addondatastore.ErrConflict), errors.Is(err, addondata.ErrUniqueIndexConflict):
		status, kind, message = http.StatusConflict, "WRITE_CONFLICT", "add-on data changed; refresh before retrying"
	case errors.Is(err, datacontract.ErrInvalidDocument):
		status, kind, message = http.StatusUnprocessableEntity, "VALIDATION_FAILED", "the document does not match its package schema"
	case errors.Is(err, addondata.ErrInvalidRequest), errors.Is(err, addondatastore.ErrInvalidTransaction):
		status, kind, message = http.StatusBadRequest, "INVALID_REQUEST", "the add-on data request is invalid"
	}
	s.logger.Error("add-on data request failed", "method", r.Method, "path", r.URL.Path, "kind", kind, "error", err)
	writeAPIError(w, status, kind, message)
}
