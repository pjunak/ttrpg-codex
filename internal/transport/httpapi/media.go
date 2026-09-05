package httpapi

import (
	"context"
	"errors"
	"mime"
	"net/http"
	"net/url"
	"os"
	"time"

	applicationmedia "github.com/pjunak/ttrpg-codex/internal/application/media"
	sessionauth "github.com/pjunak/ttrpg-codex/internal/auth"
	"github.com/pjunak/ttrpg-codex/internal/storage/blobstore"
	"github.com/pjunak/ttrpg-codex/internal/storage/maptiles"
)

const (
	mediaBlobContractVersion   = "media-blob.v1"
	mediaDeleteContractVersion = "media-delete.v1"
	mediaDeleteResultVersion   = "media-delete-result.v1"
	maximumMediaDeleteBody     = 4 << 10
)

type MediaAssets interface {
	Upload(context.Context, applicationmedia.Authority, applicationmedia.UploadRequest) (applicationmedia.Asset, error)
	Open(context.Context, applicationmedia.Authority, string) (*os.File, applicationmedia.Asset, error)
	Latest(context.Context, applicationmedia.Authority, applicationmedia.Kind, string) (applicationmedia.Asset, error)
	Delete(context.Context, applicationmedia.Authority, string, int64) (applicationmedia.Asset, error)
}

type MediaAuthorizer func(*http.Request) (applicationmedia.Authority, error)

func SessionMediaAuthorizer(service *sessionauth.Service) MediaAuthorizer {
	return func(r *http.Request) (applicationmedia.Authority, error) {
		actor, authenticated := sessionauth.ActorFromContext(r.Context())
		role := applicationmedia.RoleAnonymous
		if authenticated {
			role = applicationmedia.RolePlayer
			if actor.Role == sessionauth.RoleDM {
				role = applicationmedia.RoleDM
			}
		}
		if r.Method == http.MethodGet || r.Method == http.MethodHead {
			return applicationmedia.Authority{Role: role}, nil
		}
		if !authenticated || service == nil ||
			!service.ValidateCSRF(sessionToken(r), r.Header.Get(csrfHeaderName)) {
			return applicationmedia.Authority{}, errAuthorizationRequired
		}
		return applicationmedia.Authority{Role: role}, nil
	}
}

func (s *server) registerMediaRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/media/{kind}/{target}", s.uploadMedia)
	mux.HandleFunc("GET /api/media/latest/{kind}/{target}", s.latestMedia)
	mux.HandleFunc("GET /api/media/{blobID}", s.readMedia)
	mux.HandleFunc("GET /api/media/{blobID}/tiles/v1/manifest", s.mapManifest)
	mux.HandleFunc("GET /api/media/{blobID}/tiles/v1/{level}/{x}/{y}", s.readMapTile)
	mux.HandleFunc("DELETE /api/media/{blobID}", s.deleteMedia)
}

func (s *server) uploadMedia(w http.ResponseWriter, r *http.Request) {
	authority, err := s.mediaAuthorizer(r)
	if err != nil {
		writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "media write authorization is required")
		return
	}
	if r.URL.RawQuery != "" {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "media upload query parameters are not supported")
		return
	}
	if r.ContentLength <= 0 {
		writeAPIError(w, http.StatusLengthRequired, "LENGTH_REQUIRED", "media upload requires an exact Content-Length")
		return
	}
	originalName := ""
	if encodedName := r.Header.Get("X-Codex-Filename"); encodedName != "" {
		originalName, err = url.QueryUnescape(encodedName)
		if err != nil {
			writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "media filename encoding is invalid")
			return
		}
	}
	asset, err := s.media.Upload(r.Context(), authority, applicationmedia.UploadRequest{
		Kind: applicationmedia.Kind(r.PathValue("kind")), TargetKey: r.PathValue("target"),
		Content: r.Body, Bytes: uint64(r.ContentLength), MediaType: r.Header.Get("Content-Type"),
		OriginalName: originalName,
	})
	if err != nil {
		s.writeMediaError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, mediaResponse(asset))
}

func (s *server) latestMedia(w http.ResponseWriter, r *http.Request) {
	authority, err := s.mediaAuthorizer(r)
	if err != nil {
		writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "media read authorization is required")
		return
	}
	if r.URL.RawQuery != "" {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "media query parameters are not supported")
		return
	}
	asset, err := s.media.Latest(
		r.Context(), authority,
		applicationmedia.Kind(r.PathValue("kind")), r.PathValue("target"),
	)
	if err != nil {
		s.writeMediaError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, mediaResponse(asset))
}

func (s *server) readMedia(w http.ResponseWriter, r *http.Request) {
	authority, err := s.mediaAuthorizer(r)
	if err != nil {
		writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "media read authorization is required")
		return
	}
	if r.URL.RawQuery != "" {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "media query parameters are not supported")
		return
	}
	file, asset, err := s.media.Open(r.Context(), authority, r.PathValue("blobID"))
	if err != nil {
		s.writeMediaError(w, err)
		return
	}
	defer file.Close()
	filename := asset.Blob.OriginalName
	if filename == "" {
		filename = asset.Blob.ID
	}
	disposition := mime.FormatMediaType("inline", map[string]string{"filename": filename})
	w.Header().Set("Content-Type", asset.Blob.MediaType)
	w.Header().Set("Content-Disposition", disposition)
	w.Header().Set("ETag", `"`+asset.Blob.SHA256+`"`)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'")
	setMediaCacheHeaders(w, asset)
	http.ServeContent(w, r, filename, asset.Blob.CreatedAt, file)
}

func setMediaCacheHeaders(w http.ResponseWriter, asset applicationmedia.Asset) {
	if asset.Blob.Visibility == blobstore.VisibilityPublic {
		if asset.Binding.Kind == string(applicationmedia.CharacterPortrait) ||
			asset.Binding.Kind == string(applicationmedia.LocationMap) {
			w.Header().Set("Cache-Control", "public, no-cache")
		} else {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		}
	} else {
		w.Header().Set("Cache-Control", "private, no-store")
	}
}

func (s *server) deleteMedia(w http.ResponseWriter, r *http.Request) {
	authority, err := s.mediaAuthorizer(r)
	if err != nil {
		writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "media write authorization is required")
		return
	}
	if r.URL.RawQuery != "" {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "media deletion query parameters are not supported")
		return
	}
	var request struct {
		ContractVersion  string `json:"contractVersion"`
		ExpectedRevision int64  `json:"expectedRevision"`
	}
	if !decodeBoundedJSON(w, r, &request, maximumMediaDeleteBody, "media deletion") {
		return
	}
	if request.ContractVersion != mediaDeleteContractVersion || request.ExpectedRevision < 1 {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "media deletion contract is invalid")
		return
	}
	asset, err := s.media.Delete(r.Context(), authority, r.PathValue("blobID"), request.ExpectedRevision)
	if err != nil {
		s.writeMediaError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"contractVersion": mediaDeleteResultVersion,
		"id":              asset.Blob.ID, "revision": asset.Blob.Revision, "deleted": asset.Blob.Deleted,
	})
}

func mediaResponse(asset applicationmedia.Asset) map[string]any {
	return map[string]any{
		"contractVersion": mediaBlobContractVersion,
		"id":              asset.Blob.ID,
		"url":             "/api/media/" + asset.Blob.ID,
		"kind":            asset.Binding.Kind,
		"target":          asset.Binding.TargetKey,
		"mediaType":       asset.Blob.MediaType,
		"bytes":           asset.Blob.Bytes,
		"revision":        asset.Blob.Revision,
		"createdAt":       asset.Blob.CreatedAt.UTC().Format(time.RFC3339Nano),
	}
}

func (s *server) writeMediaError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, applicationmedia.ErrInvalid), errors.Is(err, blobstore.ErrInvalid):
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "media request is invalid")
	case errors.Is(err, applicationmedia.ErrForbidden):
		writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "media operation is forbidden")
	case errors.Is(err, applicationmedia.ErrNotFound):
		writeAPIError(w, http.StatusNotFound, "NOT_FOUND", "media asset was not found")
	case errors.Is(err, maptiles.ErrNotFound):
		writeAPIError(w, http.StatusNotFound, "NOT_FOUND", "map tile was not found")
	case errors.Is(err, maptiles.ErrUnsupported):
		writeAPIError(w, http.StatusUnsupportedMediaType, "MAP_TILES_UNAVAILABLE", "use the original map image")
	case errors.Is(err, applicationmedia.ErrConflict):
		writeAPIError(w, http.StatusConflict, "CONFLICT", "media asset revision changed")
	default:
		s.logger.Error("media operation failed", "error", err)
		writeAPIError(w, http.StatusServiceUnavailable, "MEDIA_UNAVAILABLE", "media operation is unavailable")
	}
}
