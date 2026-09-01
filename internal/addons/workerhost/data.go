// Package workerhost composes the host methods exposed to one exact native
// add-on generation. Package declarations are authority; worker parameters
// can select only data identities that the verified package owns.
package workerhost

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"strings"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/addons/datacontract"
	"github.com/pjunak/ttrpg-codex/internal/addons/packageinspect"
	"github.com/pjunak/ttrpg-codex/internal/addons/servicebroker"
	"github.com/pjunak/ttrpg-codex/internal/addons/workerbroker"
	"github.com/pjunak/ttrpg-codex/internal/application/addondata"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/addondatastore"
	"github.com/pjunak/ttrpg-codex/sdk/go/workerrpc"
)

const (
	dataGetVersion         = "host-data-get.v1"
	dataQueryVersion       = "host-data-query.v1"
	dataTransactionVersion = "host-data-transaction.v1"
	dataDocumentVersion    = "host-data-document.v1"
	dataQueryResultVersion = "host-data-query-result.v1"
	dataCommitVersion      = "host-data-commit.v1"
)

type Data interface {
	Get(context.Context, addondata.Access, datacontract.Kind, string, string) (addondatastore.Document, error)
	Query(context.Context, addondata.Query) (addondata.QueryResult, error)
	Transact(context.Context, addondata.Transaction) (addondatastore.Commit, error)
}

type Config struct {
	AddonID         string
	Generation      string
	Manifest        packageinspect.Manifest
	Data            Data
	Services        ServiceCaller
	BoundServices   []servicebroker.Handle
	ContextResolver workerbroker.ContextResolver
	OnInternalError func(workerbroker.Invocation, error)
}

type declaredData struct {
	collections map[string]struct{}
	extensions  map[string]string
	services    boundServices
}

type getRequest struct {
	ContractVersion string            `json:"contractVersion"`
	Kind            datacontract.Kind `json:"kind"`
	DataID          string            `json:"dataId"`
	Key             string            `json:"key"`
}

type queryRequest struct {
	ContractVersion string            `json:"contractVersion"`
	Kind            datacontract.Kind `json:"kind"`
	DataID          string            `json:"dataId"`
	Cursor          string            `json:"cursor,omitempty"`
	Limit           int               `json:"limit"`
	Where           []queryCondition  `json:"where"`
}

type queryCondition struct {
	Path   string          `json:"path"`
	Equals json.RawMessage `json:"equals"`
}

type transactionRequest struct {
	ContractVersion string            `json:"contractVersion"`
	Mutations       []mutationRequest `json:"mutations"`
}

type mutationRequest struct {
	Operation        addondatastore.OperationKind `json:"operation"`
	Kind             datacontract.Kind            `json:"kind"`
	DataID           string                       `json:"dataId"`
	Key              string                       `json:"key"`
	ExpectedRevision *int64                       `json:"expectedRevision"`
	Value            json.RawMessage              `json:"value,omitempty"`
}

type documentResponse struct {
	ContractVersion string          `json:"contractVersion,omitempty"`
	Key             string          `json:"key"`
	Revision        int64           `json:"revision"`
	Value           json.RawMessage `json:"value"`
}

type queryResponse struct {
	ContractVersion string             `json:"contractVersion"`
	Documents       []documentResponse `json:"documents"`
	NextCursor      string             `json:"nextCursor,omitempty"`
}

type mutationResponse struct {
	Kind           datacontract.Kind `json:"kind"`
	DataID         string            `json:"dataId"`
	Key            string            `json:"key"`
	BeforeRevision int64             `json:"beforeRevision"`
	AfterRevision  int64             `json:"afterRevision"`
	Deleted        bool              `json:"deleted"`
}

type dataSetResponse struct {
	Kind     datacontract.Kind `json:"kind"`
	DataID   string            `json:"dataId"`
	Revision int64             `json:"revision"`
}

type commitResponse struct {
	ContractVersion string             `json:"contractVersion"`
	CommitID        int64              `json:"commitId"`
	OccurredAt      time.Time          `json:"occurredAt"`
	Results         []mutationResponse `json:"results"`
	DataSets        []dataSetResponse  `json:"dataSets"`
}

func New(config Config) (*workerbroker.Dispatcher, error) {
	if config.Data == nil || config.ContextResolver == nil || config.Manifest.ID != config.AddonID ||
		!validAddonID(config.AddonID) || !validGeneration(config.Generation) ||
		(len(config.BoundServices) > 0 && config.Services == nil) {
		return nil, errors.New("worker host data configuration is invalid")
	}
	declarations, err := compileDeclarations(config.Manifest, config.BoundServices)
	if err != nil {
		return nil, err
	}
	authorize := workerbroker.AuthorizerFunc(func(_ context.Context, invocation workerbroker.Invocation) error {
		return declarations.authorize(invocation)
	})
	methods := []workerbroker.Method{
		dataGetMethod(config.Data),
		dataQueryMethod(config.Data),
		dataTransactionMethod(config.Data),
	}
	if config.Services != nil {
		methods = append(methods, serviceCallMethod(config.Services, declarations.services))
	}
	return workerbroker.New(workerbroker.Config{
		AddonID: config.AddonID, Generation: config.Generation,
		ContextResolver: config.ContextResolver,
		Authorizer:      authorize,
		Methods:         methods,
		OnInternalError: config.OnInternalError,
	})
}

func dataGetMethod(data Data) workerbroker.Method {
	return workerbroker.Method{
		Name: "host/data.get", Permission: "addon.data",
		ValidateRequest: func(body json.RawMessage) error {
			request, err := decodeExact[getRequest](body)
			if err != nil || request.ContractVersion != dataGetVersion ||
				!validReference(request.Kind, request.DataID) || !validKey(request.Key) {
				return errors.New("invalid host/data.get request")
			}
			return nil
		},
		ValidateResponse: validateDocumentResponse,
		Handle: func(ctx context.Context, invocation workerbroker.Invocation) (any, error) {
			request, err := decodeExact[getRequest](invocation.Params)
			if err != nil {
				return nil, err
			}
			document, err := data.Get(
				ctx, dataAccess(invocation), request.Kind, request.DataID, request.Key,
			)
			if err != nil {
				return nil, dataError(err)
			}
			return wireDocument(dataDocumentVersion, document), nil
		},
	}
}

func dataQueryMethod(data Data) workerbroker.Method {
	return workerbroker.Method{
		Name: "host/data.query", Permission: "addon.data",
		ValidateRequest: func(body json.RawMessage) error {
			request, err := decodeExact[queryRequest](body)
			if err != nil || request.ContractVersion != dataQueryVersion ||
				!validReference(request.Kind, request.DataID) || request.Limit < 1 ||
				request.Limit > addondata.MaximumQueryDocuments ||
				len(request.Where) > addondata.MaximumQueryConditions {
				return errors.New("invalid host/data.query request")
			}
			if _, err := decodeCursor(request.Cursor); err != nil {
				return errors.New("invalid host/data.query cursor")
			}
			for _, condition := range request.Where {
				if !validQueryCondition(condition) {
					return errors.New("invalid host/data.query condition")
				}
			}
			return nil
		},
		ValidateResponse: validateQueryResponse,
		Handle: func(ctx context.Context, invocation workerbroker.Invocation) (any, error) {
			request, err := decodeExact[queryRequest](invocation.Params)
			if err != nil {
				return nil, err
			}
			after, err := decodeCursor(request.Cursor)
			if err != nil {
				return nil, err
			}
			conditions := make([]addondata.QueryCondition, 0, len(request.Where))
			for _, condition := range request.Where {
				conditions = append(conditions, addondata.QueryCondition{
					Path: condition.Path, Equals: append(json.RawMessage(nil), condition.Equals...),
				})
			}
			result, err := data.Query(ctx, addondata.Query{
				Access: dataAccess(invocation), DataKind: request.Kind, DataID: request.DataID,
				AfterPosition: after, Limit: request.Limit, Where: conditions,
			})
			if err != nil {
				return nil, dataError(err)
			}
			response := queryResponse{
				ContractVersion: dataQueryResultVersion,
				Documents:       make([]documentResponse, 0, len(result.Documents)),
			}
			for _, document := range result.Documents {
				response.Documents = append(response.Documents, wireDocument("", document))
			}
			if result.NextPosition != nil {
				response.NextCursor = encodeCursor(*result.NextPosition)
			}
			return response, nil
		},
	}
}

func dataTransactionMethod(data Data) workerbroker.Method {
	return workerbroker.Method{
		Name: "host/data.transact", Permission: "addon.data",
		ValidateRequest: func(body json.RawMessage) error {
			request, err := decodeExact[transactionRequest](body)
			if err != nil || request.ContractVersion != dataTransactionVersion ||
				len(request.Mutations) < 1 || len(request.Mutations) > addondatastore.MaximumOperations {
				return errors.New("invalid host/data.transact request")
			}
			for _, mutation := range request.Mutations {
				if !validMutation(mutation) {
					return errors.New("invalid host/data.transact mutation")
				}
			}
			return nil
		},
		ValidateResponse: validateCommitResponse,
		Handle: func(ctx context.Context, invocation workerbroker.Invocation) (any, error) {
			request, err := decodeExact[transactionRequest](invocation.Params)
			if err != nil {
				return nil, err
			}
			mutations := make([]addondata.Mutation, 0, len(request.Mutations))
			for _, candidate := range request.Mutations {
				mutations = append(mutations, addondata.Mutation{
					Kind: candidate.Operation, DataKind: candidate.Kind, DataID: candidate.DataID,
					Key: candidate.Key, ExpectedRevision: *candidate.ExpectedRevision,
					Value: append(json.RawMessage(nil), candidate.Value...),
				})
			}
			commit, err := data.Transact(ctx, addondata.Transaction{
				Access: dataAccess(invocation), Mutations: mutations,
			})
			if err != nil {
				return nil, dataError(err)
			}
			return wireCommit(commit), nil
		},
	}
}

func compileDeclarations(
	manifest packageinspect.Manifest,
	handles []servicebroker.Handle,
) (declaredData, error) {
	services, err := compileBoundServices(manifest.ID, handles)
	if err != nil {
		return declaredData{}, err
	}
	result := declaredData{
		collections: make(map[string]struct{}, len(manifest.Collections)),
		extensions:  make(map[string]string, len(manifest.RecordExtensions)),
		services:    services,
	}
	for _, declaration := range manifest.Collections {
		result.collections[declaration.ID] = struct{}{}
	}
	for _, declaration := range manifest.RecordExtensions {
		result.extensions[declaration.ID] = declaration.Target
	}
	return result, nil
}

func (declarations declaredData) authorize(invocation workerbroker.Invocation) error {
	switch invocation.Method {
	case "host/data.get":
		request, err := decodeExact[getRequest](invocation.Params)
		if err != nil {
			return err
		}
		return declarations.authorizeReference(request.Kind, request.DataID)
	case "host/data.query":
		request, err := decodeExact[queryRequest](invocation.Params)
		if err != nil {
			return err
		}
		return declarations.authorizeReference(request.Kind, request.DataID)
	case "host/data.transact":
		request, err := decodeExact[transactionRequest](invocation.Params)
		if err != nil {
			return err
		}
		for _, mutation := range request.Mutations {
			if err := declarations.authorizeReference(mutation.Kind, mutation.DataID); err != nil {
				return err
			}
		}
		return nil
	case "host/service.call":
		request, err := decodeExact[serviceCallRequest](invocation.Params)
		if err != nil {
			return err
		}
		_, err = declarations.services.selectHandle(request.Contract, request.ProviderAddonID)
		return err
	default:
		return errors.New("worker host method is not authorized")
	}
}

func (declarations declaredData) authorizeReference(kind datacontract.Kind, dataID string) error {
	switch kind {
	case datacontract.Collection:
		if _, exists := declarations.collections[dataID]; exists {
			return nil
		}
	case datacontract.RecordExtension:
		if _, exists := declarations.extensions[dataID]; exists {
			return nil
		}
	}
	return errors.New("worker does not own the requested add-on data resource")
}

func dataAccess(invocation workerbroker.Invocation) addondata.Access {
	return addondata.Access{
		AddonID: invocation.AddonID, Generation: invocation.Generation,
		Role:    actorRole(invocation.Authority.Actor.Role),
		ActorID: boundedActorID(invocation.AddonID, invocation.Authority.Actor.ID),
	}
}

func actorRole(role string) addondata.Role {
	switch role {
	case "dm":
		return addondata.RoleDM
	case "player":
		return addondata.RolePlayer
	default:
		return addondata.RoleSystem
	}
}

func boundedActorID(addonID, actorID string) string {
	prefix := "worker:" + addonID + ":"
	if len(prefix)+len(actorID) <= 185 {
		return prefix + actorID
	}
	digest := sha256.Sum256([]byte(actorID))
	return prefix + "sha256:" + hex.EncodeToString(digest[:])
}

func wireDocument(version string, document addondatastore.Document) documentResponse {
	return documentResponse{
		ContractVersion: version, Key: document.Key, Revision: document.Revision,
		Value: append(json.RawMessage(nil), document.Value...),
	}
}

func wireCommit(commit addondatastore.Commit) commitResponse {
	response := commitResponse{
		ContractVersion: dataCommitVersion, CommitID: commit.ID, OccurredAt: commit.OccurredAt,
		Results:  make([]mutationResponse, 0, len(commit.Results)),
		DataSets: make([]dataSetResponse, 0, len(commit.DataRevisions)),
	}
	seen := make(map[string]struct{}, len(commit.DataRevisions))
	for _, result := range commit.Results {
		response.Results = append(response.Results, mutationResponse{
			Kind: result.Kind, DataID: result.DataID, Key: result.Key,
			BeforeRevision: result.BeforeRevision, AfterRevision: result.AfterRevision,
			Deleted: result.Deleted,
		})
		identity := string(result.Kind) + "\x00" + result.DataID
		if _, exists := seen[identity]; exists {
			continue
		}
		seen[identity] = struct{}{}
		response.DataSets = append(response.DataSets, dataSetResponse{
			Kind: result.Kind, DataID: result.DataID, Revision: commit.DataRevisions[identity],
		})
	}
	return response
}

func validateDocumentResponse(body json.RawMessage) error {
	response, err := decodeExact[documentResponse](body)
	if err != nil || response.ContractVersion != dataDocumentVersion ||
		!validKey(response.Key) || response.Revision < 1 || !json.Valid(response.Value) {
		return errors.New("invalid host/data.get response")
	}
	return nil
}

func validateQueryResponse(body json.RawMessage) error {
	response, err := decodeExact[queryResponse](body)
	if err != nil || response.ContractVersion != dataQueryResultVersion ||
		len(response.Documents) > addondata.MaximumQueryDocuments {
		return errors.New("invalid host/data.query response")
	}
	if _, err := decodeCursor(response.NextCursor); err != nil {
		return errors.New("invalid host/data.query response cursor")
	}
	for _, document := range response.Documents {
		if document.ContractVersion != "" || !validKey(document.Key) ||
			document.Revision < 1 || !json.Valid(document.Value) {
			return errors.New("invalid host/data.query response document")
		}
	}
	return nil
}

func validateCommitResponse(body json.RawMessage) error {
	response, err := decodeExact[commitResponse](body)
	if err != nil || response.ContractVersion != dataCommitVersion || response.CommitID < 1 ||
		response.OccurredAt.IsZero() || len(response.Results) < 1 || len(response.DataSets) < 1 {
		return errors.New("invalid host/data.transact response")
	}
	for _, result := range response.Results {
		if !validReference(result.Kind, result.DataID) || !validKey(result.Key) ||
			result.BeforeRevision < 0 || result.AfterRevision != result.BeforeRevision+1 {
			return errors.New("invalid host/data.transact result")
		}
	}
	for _, dataSet := range response.DataSets {
		if !validReference(dataSet.Kind, dataSet.DataID) || dataSet.Revision < 1 {
			return errors.New("invalid host/data.transact data set")
		}
	}
	return nil
}

func validMutation(mutation mutationRequest) bool {
	if !validReference(mutation.Kind, mutation.DataID) || !validKey(mutation.Key) ||
		mutation.ExpectedRevision == nil || *mutation.ExpectedRevision < 0 {
		return false
	}
	switch mutation.Operation {
	case addondatastore.Put:
		return len(mutation.Value) > 0 && json.Valid(mutation.Value) && string(mutation.Value) != "null"
	case addondatastore.Delete:
		return len(mutation.Value) == 0
	default:
		return false
	}
}

func validQueryCondition(condition queryCondition) bool {
	return strings.HasPrefix(condition.Path, "/") && len(condition.Path) <= 300 &&
		len(condition.Equals) > 0 && json.Valid(condition.Equals)
}

func validReference(kind datacontract.Kind, dataID string) bool {
	return (kind == datacontract.Collection || kind == datacontract.RecordExtension) &&
		validLocalID(dataID)
}

func validAddonID(value string) bool {
	return len(value) <= 80 && validDashedID(value)
}

func validLocalID(value string) bool {
	if len(value) == 0 || len(value) > 100 || value[0] < 'a' || value[0] > 'z' {
		return false
	}
	separator := false
	for _, character := range value[1:] {
		if character >= 'a' && character <= 'z' || character >= '0' && character <= '9' {
			separator = false
			continue
		}
		if (character == '.' || character == '_' || character == '-') && !separator {
			separator = true
			continue
		}
		return false
	}
	return !separator
}

func validDashedID(value string) bool {
	return validLocalID(value) && !strings.ContainsAny(value, "._")
}

func validGeneration(value string) bool {
	if len(value) != 64 || value != strings.ToLower(value) {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func validKey(value string) bool {
	return len(value) > 0 && len(value) <= 1_024
}

func encodeCursor(position int64) string {
	return base64.RawURLEncoding.EncodeToString([]byte(strconv.FormatInt(position, 10)))
}

func decodeCursor(value string) (int64, error) {
	if value == "" {
		return -1, nil
	}
	if len(value) > 32 {
		return 0, errors.New("cursor is too long")
	}
	body, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return 0, err
	}
	position, err := strconv.ParseInt(string(body), 10, 64)
	if err != nil || position < 0 || encodeCursor(position) != value {
		return 0, errors.New("cursor is invalid")
	}
	return position, nil
}

func decodeExact[T any](body json.RawMessage) (T, error) {
	var value T
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil {
		return value, err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return value, errors.New("JSON contains more than one value")
	}
	return value, nil
}

func dataError(err error) error {
	switch {
	case errors.Is(err, addondata.ErrUnauthorized):
		return workerrpc.NewRPCError(workerrpc.JSONRPCApplication, workerrpc.KindUnauthorized,
			"The worker is not allowed to access this add-on data.", false, nil)
	case errors.Is(err, addondata.ErrInactiveGeneration):
		return workerrpc.NewRPCError(workerrpc.JSONRPCApplication, workerrpc.KindStaleBinding,
			"The worker generation no longer owns add-on data authority.", false, nil)
	case errors.Is(err, addondatastore.ErrNotFound), errors.Is(err, addondata.ErrTargetNotFound),
		errors.Is(err, addondata.ErrTargetReplaced):
		return workerrpc.NewRPCError(workerrpc.JSONRPCApplication, workerrpc.KindNotFound,
			"The add-on document or its core target was not found.", false, nil)
	case errors.Is(err, addondatastore.ErrConflict), errors.Is(err, addondata.ErrUniqueIndexConflict):
		return workerrpc.NewRPCError(workerrpc.JSONRPCApplication, workerrpc.KindConflict,
			"Add-on data changed; refresh before retrying.", true, nil)
	case errors.Is(err, datacontract.ErrInvalidDocument):
		return workerrpc.NewRPCError(workerrpc.JSONRPCApplication, workerrpc.KindValidationFailed,
			"The document does not match its package schema.", false, nil)
	case errors.Is(err, addondata.ErrInvalidRequest), errors.Is(err, addondatastore.ErrInvalidTransaction):
		return workerrpc.NewRPCError(workerrpc.JSONRPCInvalidParams, workerrpc.KindInvalidRequest,
			"The add-on data request is invalid.", false, nil)
	default:
		return err
	}
}

var _ Data = (*addondata.Service)(nil)
