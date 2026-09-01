// Package contenttransport adapts immutable package content to the service
// broker's schema-validated call boundary. It implements the fixed generic
// catalog, get, and query method shapes; domain contracts choose which of
// those methods they publish.
package contenttransport

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/pjunak/ttrpg-codex/internal/addons/contentcontract"
	"github.com/pjunak/ttrpg-codex/sdk/go/workerrpc"
)

var (
	ErrInvalidRequest    = errors.New("invalid content service request")
	ErrUnsupportedMethod = errors.New("unsupported content service method")
)

const defaultQueryLimit = 50

type Caller struct {
	registry *contentcontract.Registry
}

type setDescription struct {
	ID           string                  `json:"id"`
	Revision     string                  `json:"revision"`
	Groups       *contentcontract.Groups `json:"groups,omitempty"`
	SchemaSHA256 string                  `json:"schemaSha256"`
	RecordCount  int                     `json:"recordCount"`
	Kinds        map[string]int          `json:"kinds"`
}

type recordResponse struct {
	Kind  string          `json:"kind"`
	ID    string          `json:"id"`
	Value json.RawMessage `json:"value"`
}

func New(registry *contentcontract.Registry) (*Caller, error) {
	if registry == nil || len(registry.Descriptions()) == 0 {
		return nil, contentcontract.ErrSetNotFound
	}
	return &Caller{registry: registry}, nil
}

func (caller *Caller) Supports(method string) bool {
	return method == "catalog" || method == "get" || method == "query"
}

func (caller *Caller) Call(
	ctx context.Context,
	method string,
	params any,
	_ *workerrpc.Meta,
) (json.RawMessage, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	methodName, ok := serviceMethod(method)
	if !ok || !caller.Supports(methodName) {
		return nil, fmt.Errorf("%w: %s", ErrUnsupportedMethod, method)
	}
	body, ok := params.(json.RawMessage)
	if !ok {
		encoded, err := json.Marshal(params)
		if err != nil {
			return nil, fmt.Errorf("%w: encode params: %v", ErrInvalidRequest, err)
		}
		body = encoded
	}
	var result any
	var err error
	switch methodName {
	case "catalog":
		result, err = caller.catalog(body)
	case "get":
		result, err = caller.get(body)
	case "query":
		result, err = caller.query(body)
	}
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		return nil, fmt.Errorf("encode content service response: %w", err)
	}
	return encoded, nil
}

func (caller *Caller) catalog(body json.RawMessage) (any, error) {
	var request struct{}
	if err := decodeExact(body, &request); err != nil {
		return nil, err
	}
	descriptions := caller.registry.Descriptions()
	sets := make([]setDescription, 0, len(descriptions))
	for _, description := range descriptions {
		sets = append(sets, describeSet(description))
	}
	return map[string]any{
		"contractVersion": "content-catalog.v1",
		"sets":            sets,
	}, nil
}

func (caller *Caller) get(body json.RawMessage) (any, error) {
	var request struct {
		SetID string `json:"setId"`
		Kind  string `json:"kind"`
		ID    string `json:"id"`
	}
	if err := decodeExact(body, &request); err != nil ||
		request.SetID == "" || request.Kind == "" || request.ID == "" {
		return nil, ErrInvalidRequest
	}
	description, err := caller.registry.Description(request.SetID)
	if err != nil {
		return nil, err
	}
	record, err := caller.registry.Get(request.SetID, request.Kind, request.ID)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"contractVersion": "content-record.v1",
		"setId":           description.ID,
		"revision":        description.Revision,
		"record":          contentRecord(record),
	}, nil
}

func (caller *Caller) query(body json.RawMessage) (any, error) {
	var request struct {
		SetID  string `json:"setId"`
		Kind   string `json:"kind,omitempty"`
		Cursor string `json:"cursor,omitempty"`
		Limit  int    `json:"limit,omitempty"`
	}
	if err := decodeExact(body, &request); err != nil || request.SetID == "" {
		return nil, ErrInvalidRequest
	}
	if request.Limit == 0 {
		request.Limit = defaultQueryLimit
	}
	after, err := decodeCursor(request.Cursor)
	if err != nil {
		return nil, err
	}
	description, err := caller.registry.Description(request.SetID)
	if err != nil {
		return nil, err
	}
	page, err := caller.registry.Query(contentcontract.Query{
		SetID: request.SetID, Kind: request.Kind,
		AfterPosition: after, Limit: request.Limit,
	})
	if err != nil {
		return nil, err
	}
	records := make([]recordResponse, 0, len(page.Records))
	for _, record := range page.Records {
		records = append(records, contentRecord(record))
	}
	response := map[string]any{
		"contractVersion": "content-query-result.v1",
		"setId":           description.ID,
		"revision":        description.Revision,
		"records":         records,
	}
	if page.NextPosition != nil {
		response["nextCursor"] = encodeCursor(*page.NextPosition)
	}
	return response, nil
}

func decodeExact(body json.RawMessage, destination any) error {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidRequest, err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return ErrInvalidRequest
	}
	return nil
}

func serviceMethod(value string) (string, bool) {
	if !strings.HasPrefix(value, "service/") {
		return "", false
	}
	remainder := strings.TrimPrefix(value, "service/")
	separator := strings.LastIndexByte(remainder, '/')
	if separator <= 0 || separator == len(remainder)-1 {
		return "", false
	}
	return remainder[separator+1:], true
}

func describeSet(description contentcontract.Description) setDescription {
	return setDescription{
		ID: description.ID, Revision: description.Revision, Groups: description.Groups,
		SchemaSHA256: description.SchemaSHA256, RecordCount: description.RecordCount,
		Kinds: description.Kinds,
	}
}

func contentRecord(record contentcontract.Record) recordResponse {
	return recordResponse{Kind: record.Kind, ID: record.ID, Value: record.Value}
}

func encodeCursor(position int) string {
	return base64.RawURLEncoding.EncodeToString([]byte(strconv.Itoa(position)))
}

func decodeCursor(value string) (int, error) {
	if value == "" {
		return -1, nil
	}
	if len(value) > 32 {
		return 0, ErrInvalidRequest
	}
	body, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return 0, ErrInvalidRequest
	}
	position, err := strconv.Atoi(string(body))
	if err != nil || position < 0 || encodeCursor(position) != value {
		return 0, ErrInvalidRequest
	}
	return position, nil
}
