package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/pjunak/ttrpg-codex/internal/addons/contentcontract"
	"github.com/pjunak/ttrpg-codex/internal/addons/packagemanager"
)

const (
	addonContentCatalogVersion = "addon-content-catalog.v1"
	addonContentRecordVersion  = "addon-content-record.v1"
	addonContentQueryVersion   = "addon-content-query-result.v1"
	defaultContentQueryLimit   = 50
)

type AddonContent interface {
	ContentRegistry(addonID, generationID string) (*contentcontract.Registry, error)
}

var _ AddonContent = (*packagemanager.Manager)(nil)

type addonContentSetResponse struct {
	ID           string                  `json:"id"`
	Revision     string                  `json:"revision"`
	Groups       *contentcontract.Groups `json:"groups,omitempty"`
	SchemaSHA256 string                  `json:"schemaSha256"`
	RecordCount  int                     `json:"recordCount"`
	Kinds        map[string]int          `json:"kinds"`
}

type addonContentRecordResponse struct {
	Kind  string          `json:"kind"`
	ID    string          `json:"id"`
	Value json.RawMessage `json:"value"`
}

func (s *server) registerAddonContentRoutes(mux *http.ServeMux) {
	base := "/api/addons/{addonID}/generations/{generationID}/content"
	mux.Handle("GET "+base, s.requireAddonContent(http.HandlerFunc(s.addonContentCatalog)))
	mux.Handle("GET "+base+"/records", s.requireAddonContent(http.HandlerFunc(s.addonContentRecord)))
	mux.Handle("GET "+base+"/query", s.requireAddonContent(http.HandlerFunc(s.addonContentQuery)))
}

func (s *server) requireAddonContent(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := s.contentAuthorizer(r); err != nil {
			s.logger.Warn("add-on content access denied", "method", r.Method, "path", r.URL.Path)
			writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "add-on content authorization is required")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *server) addonContentRegistry(
	w http.ResponseWriter,
	r *http.Request,
) (*contentcontract.Registry, string, string, bool) {
	addonID, ok := pathResourceID(w, r, "addonID")
	if !ok {
		return nil, "", "", false
	}
	generationID, ok := pathResourceID(w, r, "generationID")
	if !ok || !validAddonGeneration(generationID) {
		if ok {
			writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "generationID is invalid")
		}
		return nil, "", "", false
	}
	registry, err := s.addonContent.ContentRegistry(addonID, generationID)
	if err != nil {
		s.writeAddonContentError(w, r, err)
		return nil, "", "", false
	}
	return registry, addonID, generationID, true
}

func (s *server) addonContentCatalog(w http.ResponseWriter, r *http.Request) {
	if r.URL.RawQuery != "" {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "query parameters are not supported")
		return
	}
	registry, addonID, generationID, ok := s.addonContentRegistry(w, r)
	if !ok {
		return
	}
	descriptions := registry.Descriptions()
	sets := make([]addonContentSetResponse, 0, len(descriptions))
	for _, description := range descriptions {
		sets = append(sets, contentSetResponse(description))
	}
	writeAddonContentJSON(w, http.StatusOK, map[string]any{
		"contractVersion": addonContentCatalogVersion,
		"addonId":         addonID,
		"generationId":    generationID,
		"sets":            sets,
	})
}

func (s *server) addonContentRecord(w http.ResponseWriter, r *http.Request) {
	query, ok := exactContentQuery(w, r, []string{"set", "kind", "id"})
	if !ok {
		return
	}
	registry, addonID, generationID, ok := s.addonContentRegistry(w, r)
	if !ok {
		return
	}
	description, err := registry.Description(query["set"])
	if err != nil {
		s.writeAddonContentError(w, r, err)
		return
	}
	record, err := registry.Get(query["set"], query["kind"], query["id"])
	if err != nil {
		s.writeAddonContentError(w, r, err)
		return
	}
	writeAddonContentJSON(w, http.StatusOK, map[string]any{
		"contractVersion": addonContentRecordVersion,
		"addonId":         addonID,
		"generationId":    generationID,
		"setId":           description.ID,
		"revision":        description.Revision,
		"record":          contentRecordResponse(record),
	})
}

func (s *server) addonContentQuery(w http.ResponseWriter, r *http.Request) {
	query, ok := boundedContentQuery(w, r)
	if !ok {
		return
	}
	registry, addonID, generationID, ok := s.addonContentRegistry(w, r)
	if !ok {
		return
	}
	description, err := registry.Description(query.SetID)
	if err != nil {
		s.writeAddonContentError(w, r, err)
		return
	}
	query.AfterPosition, err = contentcontract.DecodeCursor(r.URL.Query().Get("cursor"), query.SetID, description.Revision, query.Kind)
	if err != nil {
		s.writeAddonContentError(w, r, err)
		return
	}
	result, err := registry.Query(query)
	if err != nil {
		s.writeAddonContentError(w, r, err)
		return
	}
	records := make([]addonContentRecordResponse, 0, len(result.Records))
	for _, record := range result.Records {
		records = append(records, contentRecordResponse(record))
	}
	response := map[string]any{
		"contractVersion": addonContentQueryVersion,
		"addonId":         addonID,
		"generationId":    generationID,
		"setId":           description.ID,
		"revision":        description.Revision,
		"records":         records,
	}
	if result.NextPosition != nil {
		response["nextCursor"] = contentcontract.EncodeCursor(*result.NextPosition, query.SetID, description.Revision, query.Kind)
	}
	writeAddonContentJSON(w, http.StatusOK, response)
}

func exactContentQuery(
	w http.ResponseWriter,
	r *http.Request,
	required []string,
) (map[string]string, bool) {
	allowed := make(map[string]struct{}, len(required))
	result := make(map[string]string, len(required))
	for _, name := range required {
		allowed[name] = struct{}{}
	}
	for name, values := range r.URL.Query() {
		if _, exists := allowed[name]; !exists || len(values) != 1 || values[0] == "" {
			writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "add-on content query parameters are invalid")
			return nil, false
		}
		result[name] = values[0]
	}
	for _, name := range required {
		if result[name] == "" {
			writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "add-on content query parameters are invalid")
			return nil, false
		}
	}
	return result, true
}

func boundedContentQuery(w http.ResponseWriter, r *http.Request) (contentcontract.Query, bool) {
	values := r.URL.Query()
	for name, candidates := range values {
		if name != "set" && name != "kind" && name != "cursor" && name != "limit" || len(candidates) != 1 {
			writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "add-on content query parameters are invalid")
			return contentcontract.Query{}, false
		}
	}
	setID := values.Get("set")
	if setID == "" {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "set is required")
		return contentcontract.Query{}, false
	}
	limit := defaultContentQueryLimit
	var err error
	if value := values.Get("limit"); value != "" {
		limit, err = strconv.Atoi(value)
	}
	if err != nil || len(values.Get("cursor")) > 32 || limit < 1 || limit > contentcontract.MaximumQueryRecords {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "add-on content query bounds are invalid")
		return contentcontract.Query{}, false
	}
	return contentcontract.Query{
		SetID: setID, Kind: values.Get("kind"), AfterPosition: -1, Limit: limit,
	}, true
}

func contentSetResponse(description contentcontract.Description) addonContentSetResponse {
	return addonContentSetResponse{
		ID: description.ID, Revision: description.Revision, Groups: description.Groups,
		SchemaSHA256: description.SchemaSHA256, RecordCount: description.RecordCount,
		Kinds: description.Kinds,
	}
}

func contentRecordResponse(record contentcontract.Record) addonContentRecordResponse {
	return addonContentRecordResponse{Kind: record.Kind, ID: record.ID, Value: record.Value}
}

func writeAddonContentJSON(w http.ResponseWriter, status int, value any) {
	setPrivateBrowserHeaders(w)
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func (s *server) writeAddonContentError(w http.ResponseWriter, r *http.Request, err error) {
	status, kind, message := http.StatusServiceUnavailable, "ADDON_CONTENT_UNAVAILABLE", "add-on content is unavailable"
	switch {
	case errors.Is(err, packagemanager.ErrNotActive):
		status, kind, message = http.StatusConflict, "STALE_GENERATION", "the add-on generation is no longer active"
	case errors.Is(err, contentcontract.ErrSetNotFound), errors.Is(err, contentcontract.ErrRecordNotFound):
		status, kind, message = http.StatusNotFound, "NOT_FOUND", "the add-on content record or set was not found"
	case errors.Is(err, contentcontract.ErrInvalidQuery):
		status, kind, message = http.StatusBadRequest, "INVALID_REQUEST", "the add-on content query is invalid"
	}
	s.logger.Error("add-on content request failed", "method", r.Method, "path", r.URL.Path, "kind", kind, "error", err)
	writeAPIError(w, status, kind, message)
}
