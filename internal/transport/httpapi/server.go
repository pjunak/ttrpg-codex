package httpapi

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io/fs"
	"log/slog"
	"net/http"
	"time"

	sessionauth "github.com/pjunak/ttrpg-codex/internal/auth"
)

var ErrInvalidConfig = errors.New("invalid HTTP API configuration")

type Config struct {
	Version                  string
	DB                       *sql.DB
	Logger                   *slog.Logger
	AddonLifecycle           AddonLifecycle
	AddonGitHub              AddonGitHub
	AdminAuthorizer          AdminAuthorizer
	BrowserAddons            BrowserAddonSource
	BrowserAuthorizer        BrowserAuthorizer
	Authentication           *sessionauth.Service
	SecureCookies            bool
	CampaignData             CampaignData
	CampaignMutations        CampaignMutations
	CampaignWriter           CampaignMutationAuthorizer
	CampaignTwins            CampaignTwins
	CampaignTwinWriter       CampaignMutationAuthorizer
	CampaignEnums            CampaignEnums
	CampaignEnumWriter       CampaignMutationAuthorizer
	BackupArchives           BackupArchives
	RecoveryPoints           RecoveryPoints
	BackupAuthorizer         AdminAuthorizer
	Media                    MediaAssets
	MediaAuthorizer          MediaAuthorizer
	AddonData                AddonData
	AddonDataAuthorizer      AddonDataAuthorizer
	AddonContent             AddonContent
	ContentAuthorizer        BrowserAuthorizer
	BrowserServices          BrowserServices
	BrowserServiceAuthorizer BrowserServiceAuthorizer
	Events                   EventSource
	EventAuthorizer          EventAuthorizer
	EventHeartbeat           time.Duration
	Frontend                 fs.FS
}

type server struct {
	version                  string
	db                       *sql.DB
	logger                   *slog.Logger
	addonLifecycle           AddonLifecycle
	addonGitHub              AddonGitHub
	adminAuthorizer          AdminAuthorizer
	browserAddons            BrowserAddonSource
	browserAuthorizer        BrowserAuthorizer
	authentication           *sessionauth.Service
	secureCookies            bool
	campaignData             CampaignData
	campaignMutations        CampaignMutations
	campaignWriter           CampaignMutationAuthorizer
	campaignTwins            CampaignTwins
	campaignTwinWriter       CampaignMutationAuthorizer
	campaignEnums            CampaignEnums
	campaignEnumWriter       CampaignMutationAuthorizer
	backupArchives           BackupArchives
	recoveryPoints           RecoveryPoints
	backupAuthorizer         AdminAuthorizer
	media                    MediaAssets
	mediaAuthorizer          MediaAuthorizer
	addonData                AddonData
	addonDataAuthorizer      AddonDataAuthorizer
	addonContent             AddonContent
	contentAuthorizer        BrowserAuthorizer
	browserServices          BrowserServices
	browserServiceAuthorizer BrowserServiceAuthorizer
	loginLimiter             *loginLimiter
	events                   EventSource
	eventAuthorizer          EventAuthorizer
	eventHeartbeat           time.Duration
	frontend                 http.Handler
}

func New(config Config) (http.Handler, error) {
	if (config.AddonLifecycle == nil) != (config.AdminAuthorizer == nil) ||
		config.AddonGitHub != nil && config.AddonLifecycle == nil ||
		(config.BrowserAddons == nil) != (config.BrowserAuthorizer == nil) ||
		(config.CampaignMutations == nil) != (config.CampaignWriter == nil) ||
		(config.CampaignTwins == nil) != (config.CampaignTwinWriter == nil) ||
		(config.CampaignEnums == nil) != (config.CampaignEnumWriter == nil) ||
		(config.BackupArchives == nil) != (config.BackupAuthorizer == nil) ||
		config.RecoveryPoints != nil && config.Authentication == nil ||
		(config.Media == nil) != (config.MediaAuthorizer == nil) ||
		(config.AddonData == nil) != (config.AddonDataAuthorizer == nil) ||
		(config.AddonContent == nil) != (config.ContentAuthorizer == nil) ||
		(config.BrowserServices == nil) != (config.BrowserServiceAuthorizer == nil) ||
		(config.Events == nil) != (config.EventAuthorizer == nil) ||
		config.EventHeartbeat < 0 || config.EventHeartbeat > 5*time.Minute ||
		config.EventHeartbeat > 0 && config.EventHeartbeat < time.Second {
		return nil, ErrInvalidConfig
	}
	if config.Logger == nil {
		config.Logger = slog.Default()
	}
	frontend, err := newFrontendHandler(config.Frontend)
	if err != nil {
		return nil, err
	}
	s := &server{
		version: config.Version, db: config.DB, logger: config.Logger,
		addonLifecycle: config.AddonLifecycle, adminAuthorizer: config.AdminAuthorizer,
		addonGitHub:   config.AddonGitHub,
		browserAddons: config.BrowserAddons, browserAuthorizer: config.BrowserAuthorizer,
		authentication: config.Authentication, secureCookies: config.SecureCookies,
		campaignData:      config.CampaignData,
		campaignMutations: config.CampaignMutations, campaignWriter: config.CampaignWriter,
		campaignTwins: config.CampaignTwins, campaignTwinWriter: config.CampaignTwinWriter,
		campaignEnums: config.CampaignEnums, campaignEnumWriter: config.CampaignEnumWriter,
		backupArchives: config.BackupArchives, backupAuthorizer: config.BackupAuthorizer,
		recoveryPoints: config.RecoveryPoints,
		media:          config.Media, mediaAuthorizer: config.MediaAuthorizer,
		addonData: config.AddonData, addonDataAuthorizer: config.AddonDataAuthorizer,
		addonContent: config.AddonContent, contentAuthorizer: config.ContentAuthorizer,
		browserServices:          config.BrowserServices,
		browserServiceAuthorizer: config.BrowserServiceAuthorizer,
		loginLimiter:             newLoginLimiter(), events: config.Events,
		eventAuthorizer: config.EventAuthorizer, eventHeartbeat: config.EventHeartbeat,
		frontend: frontend,
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", s.health)
	mux.HandleFunc("GET /api/version", s.versionInfo)
	if s.authentication != nil {
		s.registerAuthenticationRoutes(mux)
	}
	if s.addonLifecycle != nil {
		s.registerAddonAdminRoutes(mux)
	}
	if s.addonGitHub != nil {
		s.registerAddonGitHubRoutes(mux)
	}
	if s.browserAddons != nil {
		s.registerBrowserAddonRoutes(mux)
	}
	if s.events != nil {
		s.registerEventRoutes(mux)
	}
	if s.campaignData != nil || s.campaignMutations != nil || s.campaignTwins != nil || s.campaignEnums != nil {
		s.registerCampaignRoutes(mux)
	}
	if s.backupArchives != nil {
		s.registerBackupRoutes(mux)
	}
	if s.recoveryPoints != nil {
		s.registerRecoveryRoutes(mux)
	}
	if s.media != nil {
		s.registerMediaRoutes(mux)
	}
	if s.addonData != nil {
		s.registerAddonDataRoutes(mux)
	}
	if s.addonContent != nil {
		s.registerAddonContentRoutes(mux)
	}
	if s.browserServices != nil {
		s.registerBrowserServiceRoutes(mux)
	}
	if s.frontend != nil {
		mux.Handle("GET /", s.frontend)
	}
	handler := http.Handler(mux)
	if s.authentication != nil {
		handler = s.attachSession(handler)
	}
	return requestLog(config.Logger, handler), nil
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
