package httpapi

import (
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"
)

var ErrInvalidConfig = errors.New("invalid HTTP API configuration")

type Config struct {
	Version           string
	DB                *sql.DB
	Logger            *slog.Logger
	AddonLifecycle    AddonLifecycle
	AdminAuthorizer   AdminAuthorizer
	BrowserAddons     BrowserAddonSource
	BrowserAuthorizer BrowserAuthorizer
}

type server struct {
	version           string
	db                *sql.DB
	logger            *slog.Logger
	addonLifecycle    AddonLifecycle
	adminAuthorizer   AdminAuthorizer
	browserAddons     BrowserAddonSource
	browserAuthorizer BrowserAuthorizer
}

func New(config Config) (http.Handler, error) {
	if (config.AddonLifecycle == nil) != (config.AdminAuthorizer == nil) ||
		(config.BrowserAddons == nil) != (config.BrowserAuthorizer == nil) {
		return nil, ErrInvalidConfig
	}
	if config.Logger == nil {
		config.Logger = slog.Default()
	}
	s := &server{
		version: config.Version, db: config.DB, logger: config.Logger,
		addonLifecycle: config.AddonLifecycle, adminAuthorizer: config.AdminAuthorizer,
		browserAddons: config.BrowserAddons, browserAuthorizer: config.BrowserAuthorizer,
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", s.health)
	mux.HandleFunc("GET /api/version", s.versionInfo)
	if s.addonLifecycle != nil {
		s.registerAddonAdminRoutes(mux)
	}
	if s.browserAddons != nil {
		s.registerBrowserAddonRoutes(mux)
	}
	return requestLog(config.Logger, mux), nil
}

func (s *server) health(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	if s.db == nil || s.db.PingContext(ctx) != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"status": "unavailable",
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status":  "ok",
		"version": s.version,
	})
}

func (s *server) versionInfo(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"version": s.version,
		"runtime": "go",
	})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func requestLog(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		next.ServeHTTP(w, r)
		logger.Debug("HTTP request", "method", r.Method, "path", r.URL.Path, "duration", time.Since(started))
	})
}
