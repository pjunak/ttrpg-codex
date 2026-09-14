package httpapi

import (
	"context"
	"net/http"

	"github.com/pjunak/ttrpg-codex/internal/addons/packagemanager"
)

type AddonPackageStorage interface {
	PackageStorage(context.Context, int64, int64) (packagemanager.PackageStorage, error)
	RestorePackage(context.Context, string, string) (packagemanager.Generation, error)
	PrepareRecoveryPackages(context.Context, int64, int64) (packagemanager.PackageStorage, error)
	RetryPackageEvictions(context.Context) error
}

func (s *server) packageStorage(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	storage, ok := s.addonLifecycle.(AddonPackageStorage)
	if !ok {
		writeAPIError(w, 503, "UNAVAILABLE", "package storage is unavailable")
		return
	}
	if r.URL.RawQuery != "" {
		writeAPIError(w, 400, "INVALID_REQUEST", "query parameters are not supported")
		return
	}
	ctx, cancel := githubRequestContext(w, r)
	defer cancel()
	var result any
	var err error
	if r.Method == "GET" {
		result, err = storage.PackageStorage(ctx, 0, 0)
	} else {
		switch r.PathValue("operation") {
		case "restore":
			var request struct {
				AddonID      string `json:"addonId"`
				GenerationID string `json:"generationId"`
			}
			if !decodeAdminJSON(w, r, &request) {
				return
			}
			if !validAddonGeneration(request.GenerationID) {
				writeAPIError(w, 400, "INVALID_REQUEST", "an exact package generation is required")
				return
			}
			result, err = storage.RestorePackage(ctx, request.AddonID, request.GenerationID)
		case "review", "prepare":
			var request struct {
				PointID          int64 `json:"pointId"`
				ExpectedRevision int64 `json:"expectedRevision"`
			}
			if !decodeAdminJSON(w, r, &request) {
				return
			}
			if request.PointID < 1 || request.ExpectedRevision < 0 {
				writeAPIError(w, 400, "INVALID_REQUEST", "a reviewed recovery point is required")
				return
			}
			if r.PathValue("operation") == "prepare" {
				result, err = storage.PrepareRecoveryPackages(ctx, request.PointID, request.ExpectedRevision)
			} else {
				result, err = storage.PackageStorage(ctx, request.PointID, request.ExpectedRevision)
			}
		case "retry":
			var request struct{}
			if !decodeAdminJSON(w, r, &request) {
				return
			}
			err = storage.RetryPackageEvictions(ctx)
			if err == nil {
				result, err = storage.PackageStorage(ctx, 0, 0)
			}
		default:
			writeAPIError(w, 404, "NOT_FOUND", "package storage operation not found")
			return
		}
	}
	if err != nil {
		s.writeLifecycleError(w, r, err)
		return
	}
	writeJSON(w, 200, result)
}
