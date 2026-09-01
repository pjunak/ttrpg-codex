package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"

	"github.com/pjunak/ttrpg-codex/internal/addons/packageinspect"
	"github.com/pjunak/ttrpg-codex/internal/addons/packagemanager"
)

const (
	maxAdminRequestBytes = 64 << 10
	defaultEventLimit    = 100
	maxEventLimit        = 500
)

var maxAddonPackageBytes = packageinspect.DefaultLimits.MaxArchiveBytes

type AddonLifecycle interface {
	StageArchive(context.Context, io.Reader) (packagemanager.Generation, error)
	Snapshot(context.Context, string, int) (packagemanager.Snapshot, error)
	PrepareActivationReview(context.Context, string, string) (packagemanager.ActivationReview, error)
	GetActivationReview(context.Context, string) (packagemanager.ActivationReview, error)
	ApproveActivationReview(context.Context, string, []string) (packagemanager.ActivationReview, error)
	ActivateReviewed(context.Context, string) (packagemanager.ActivationResult, error)
	Reload(context.Context, string, int64) (packagemanager.ActivationResult, error)
	Disable(context.Context, packagemanager.DisablePlan) (packagemanager.DisableResult, error)
}

type AdminAuthorizer func(*http.Request) error

var _ AddonLifecycle = (*packagemanager.Manager)(nil)

func (s *server) registerAddonAdminRoutes(mux *http.ServeMux) {
	mux.Handle("POST /api/admin/addons/generations", s.requireAdmin(http.HandlerFunc(s.stageAddonGeneration)))
	mux.Handle("GET /api/admin/addons/{addonID}", s.requireAdmin(http.HandlerFunc(s.addonSnapshot)))
	mux.Handle("POST /api/admin/addons/{addonID}/activation-reviews", s.requireAdmin(http.HandlerFunc(s.prepareActivationReview)))
	mux.Handle("POST /api/admin/addons/{addonID}/reload", s.requireAdmin(http.HandlerFunc(s.reloadAddon)))
	mux.Handle("POST /api/admin/addons/{addonID}/disable", s.requireAdmin(http.HandlerFunc(s.disableAddon)))
	mux.Handle("GET /api/admin/addon-activation-reviews/{reviewID}", s.requireAdmin(http.HandlerFunc(s.activationReview)))
	mux.Handle("POST /api/admin/addon-activation-reviews/{reviewID}/approval", s.requireAdmin(http.HandlerFunc(s.approveActivationReview)))
	mux.Handle("POST /api/admin/addon-activation-reviews/{reviewID}/activation", s.requireAdmin(http.HandlerFunc(s.activateReviewed)))
}

func (s *server) stageAddonGeneration(w http.ResponseWriter, r *http.Request) {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/zip" {
		writeAPIError(w, http.StatusUnsupportedMediaType, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/zip")
		return
	}
	if r.ContentLength > maxAddonPackageBytes {
		writeAddonPackageTooLarge(w)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxAddonPackageBytes)
	generation, err := s.addonLifecycle.StageArchive(r.Context(), r.Body)
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeAddonPackageTooLarge(w)
			return
		}
		s.writeLifecycleError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, generation)
}

func writeAddonPackageTooLarge(w http.ResponseWriter) {
	writeAPIError(
		w, http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE",
		fmt.Sprintf("add-on package exceeds the %d MiB limit", maxAddonPackageBytes>>20),
	)
}

func (s *server) requireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := s.adminAuthorizer(r); err != nil {
			s.logger.Warn("add-on administration denied", "method", r.Method, "path", r.URL.Path)
			writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "administrator authorization is required")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *server) addonSnapshot(w http.ResponseWriter, r *http.Request) {
	addonID, ok := pathResourceID(w, r, "addonID")
	if !ok {
		return
	}
	eventLimit, err := parseEventLimit(r)
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", err.Error())
		return
	}
	snapshot, err := s.addonLifecycle.Snapshot(r.Context(), addonID, eventLimit)
	if err != nil {
		s.writeLifecycleError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, snapshot)
}

func (s *server) prepareActivationReview(w http.ResponseWriter, r *http.Request) {
	addonID, ok := pathResourceID(w, r, "addonID")
	if !ok {
		return
	}
	var request struct {
		GenerationID string `json:"generationId"`
	}
	if !decodeAdminJSON(w, r, &request) {
		return
	}
	if !validResourceID(request.GenerationID) {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "generationId is invalid")
		return
	}
	review, err := s.addonLifecycle.PrepareActivationReview(r.Context(), addonID, request.GenerationID)
	if err != nil {
		s.writeLifecycleError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, review)
}

func (s *server) activationReview(w http.ResponseWriter, r *http.Request) {
	reviewID, ok := pathResourceID(w, r, "reviewID")
	if !ok {
		return
	}
	review, err := s.addonLifecycle.GetActivationReview(r.Context(), reviewID)
	if err != nil {
		s.writeLifecycleError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, review)
}

func (s *server) approveActivationReview(w http.ResponseWriter, r *http.Request) {
	reviewID, ok := pathResourceID(w, r, "reviewID")
	if !ok {
		return
	}
	var request struct {
		GrantedPermissionIDs []string `json:"grantedPermissionIds"`
	}
	if !decodeAdminJSON(w, r, &request) {
		return
	}
	if request.GrantedPermissionIDs == nil {
		request.GrantedPermissionIDs = []string{}
	}
	review, err := s.addonLifecycle.ApproveActivationReview(
		r.Context(), reviewID, request.GrantedPermissionIDs,
	)
	if err != nil {
		s.writeLifecycleError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, review)
}

func (s *server) activateReviewed(w http.ResponseWriter, r *http.Request) {
	reviewID, ok := pathResourceID(w, r, "reviewID")
	if !ok {
		return
	}
	result, err := s.addonLifecycle.ActivateReviewed(r.Context(), reviewID)
	if err != nil {
		s.writeLifecycleError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *server) reloadAddon(w http.ResponseWriter, r *http.Request) {
	addonID, revision, ok := decodeRevisionRequest(w, r)
	if !ok {
		return
	}
	result, err := s.addonLifecycle.Reload(r.Context(), addonID, revision)
	if err != nil {
		s.writeLifecycleError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *server) disableAddon(w http.ResponseWriter, r *http.Request) {
	addonID, revision, ok := decodeRevisionRequest(w, r)
	if !ok {
		return
	}
	result, err := s.addonLifecycle.Disable(r.Context(), packagemanager.DisablePlan{
		AddonID: addonID, ExpectedStateRevision: revision,
	})
	if err != nil {
		s.writeLifecycleError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func decodeRevisionRequest(w http.ResponseWriter, r *http.Request) (string, int64, bool) {
	addonID, ok := pathResourceID(w, r, "addonID")
	if !ok {
		return "", 0, false
	}
	var request struct {
		ExpectedStateRevision *int64 `json:"expectedStateRevision"`
	}
	if !decodeAdminJSON(w, r, &request) {
		return "", 0, false
	}
	if request.ExpectedStateRevision == nil || *request.ExpectedStateRevision < 0 {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "expectedStateRevision must be a non-negative integer")
		return "", 0, false
	}
	return addonID, *request.ExpectedStateRevision, true
}

func decodeAdminJSON(w http.ResponseWriter, r *http.Request, destination any) bool {
	return decodeBoundedJSON(w, r, destination, maxAdminRequestBytes, "administrative API")
}

func decodeBoundedJSON(w http.ResponseWriter, r *http.Request, destination any, maximum int64, boundary string) bool {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		writeAPIError(w, http.StatusUnsupportedMediaType, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json")
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, maximum)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeAPIError(w, http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE", "request body exceeds the "+boundary+" limit")
			return false
		}
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "request body must be valid JSON")
		return false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeAPIError(w, http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE", "request body exceeds the "+boundary+" limit")
			return false
		}
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "request body must contain one JSON value")
		return false
	}
	return true
}

func pathResourceID(w http.ResponseWriter, r *http.Request, name string) (string, bool) {
	value := r.PathValue(name)
	if !validResourceID(value) {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", name+" is invalid")
		return "", false
	}
	return value, true
}

func validResourceID(value string) bool {
	if len(value) == 0 || len(value) > 128 {
		return false
	}
	for _, character := range value {
		if character >= 'a' && character <= 'z' ||
			character >= 'A' && character <= 'Z' ||
			character >= '0' && character <= '9' ||
			strings.ContainsRune("._-", character) {
			continue
		}
		return false
	}
	return true
}

func parseEventLimit(r *http.Request) (int, error) {
	query := r.URL.Query()
	for key := range query {
		if key != "eventLimit" {
			return 0, fmt.Errorf("query parameter %q is not supported", key)
		}
	}
	values := query["eventLimit"]
	if len(values) == 0 || len(values) == 1 && values[0] == "" {
		return defaultEventLimit, nil
	}
	if len(values) != 1 {
		return 0, errors.New("eventLimit must be specified once")
	}
	value := values[0]
	limit, err := strconv.Atoi(value)
	if err != nil || limit < 0 || limit > maxEventLimit {
		return 0, fmt.Errorf("eventLimit must be between 0 and %d", maxEventLimit)
	}
	return limit, nil
}

func (s *server) writeLifecycleError(w http.ResponseWriter, r *http.Request, err error) {
	status, kind, message := classifyLifecycleError(err)
	s.logger.Error("add-on administration failed", "method", r.Method, "path", r.URL.Path, "kind", kind, "error", err)
	writeAPIError(w, status, kind, message)
}

func classifyLifecycleError(err error) (int, string, string) {
	classifications := []struct {
		target  error
		status  int
		kind    string
		message string
	}{
		{packagemanager.ErrGenerationNotFound, http.StatusNotFound, "GENERATION_NOT_FOUND", packagemanager.ErrGenerationNotFound.Error()},
		{packagemanager.ErrReviewNotFound, http.StatusNotFound, "REVIEW_NOT_FOUND", packagemanager.ErrReviewNotFound.Error()},
		{packagemanager.ErrNotActive, http.StatusConflict, "ADDON_NOT_ACTIVE", packagemanager.ErrNotActive.Error()},
		{packagemanager.ErrStaleActivationPlan, http.StatusConflict, "STALE_STATE", packagemanager.ErrStaleActivationPlan.Error()},
		{packagemanager.ErrReviewState, http.StatusConflict, "REVIEW_STATE", packagemanager.ErrReviewState.Error()},
		{packagemanager.ErrReviewStale, http.StatusConflict, "REVIEW_STALE", packagemanager.ErrReviewStale.Error()},
		{packagemanager.ErrActivationCohort, http.StatusConflict, "ACTIVATION_COHORT_REQUIRED", packagemanager.ErrActivationCohort.Error()},
		{packagemanager.ErrRecoveryRequired, http.StatusConflict, "RECOVERY_REQUIRED", packagemanager.ErrRecoveryRequired.Error()},
		{packagemanager.ErrInvalidPackage, http.StatusUnprocessableEntity, "INVALID_PACKAGE", packagemanager.ErrInvalidPackage.Error()},
		{packagemanager.ErrCompatibility, http.StatusUnprocessableEntity, "COMPATIBILITY", packagemanager.ErrCompatibility.Error()},
		{packagemanager.ErrCapability, http.StatusUnprocessableEntity, "CAPABILITY", packagemanager.ErrCapability.Error()},
		{packagemanager.ErrPermission, http.StatusUnprocessableEntity, "PERMISSION", packagemanager.ErrPermission.Error()},
		{packagemanager.ErrDependency, http.StatusUnprocessableEntity, "DEPENDENCY", packagemanager.ErrDependency.Error()},
		{packagemanager.ErrServiceResolution, http.StatusUnprocessableEntity, "SERVICE_RESOLUTION", packagemanager.ErrServiceResolution.Error()},
		{packagemanager.ErrRuntimeUnsupported, http.StatusUnprocessableEntity, "RUNTIME_UNSUPPORTED", packagemanager.ErrRuntimeUnsupported.Error()},
		{packagemanager.ErrReviewBlocked, http.StatusUnprocessableEntity, "REVIEW_BLOCKED", packagemanager.ErrReviewBlocked.Error()},
		{packagemanager.ErrActivationFailed, http.StatusServiceUnavailable, "ACTIVATION_FAILED", packagemanager.ErrActivationFailed.Error()},
	}
	for _, classification := range classifications {
		if errors.Is(err, classification.target) {
			return classification.status, classification.kind, classification.message
		}
	}
	return http.StatusInternalServerError, "INTERNAL", "the add-on lifecycle request failed"
}

func writeAPIError(w http.ResponseWriter, status int, kind string, message string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]string{"kind": kind, "message": message},
	})
}
