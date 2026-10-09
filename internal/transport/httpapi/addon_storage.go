package httpapi

import (
	"context"
	"net/http"

	"github.com/pjunak/ttrpg-codex/internal/addons/packagemanager"
)

type AddonPackageStorage interface {
	PackageStorage(context.Context) (packagemanager.PackageStorage, error)
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
	result, err := storage.PackageStorage(r.Context())
	if err != nil {
		s.writeLifecycleError(w, r, err)
		return
	}
	writeJSON(w, 200, result)
}
