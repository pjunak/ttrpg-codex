package main

import (
	"context"
	"database/sql"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/addons/packageinspect"
	"github.com/pjunak/ttrpg-codex/internal/addons/packagemanager"
	"github.com/pjunak/ttrpg-codex/internal/addons/requestcontext"
	"github.com/pjunak/ttrpg-codex/internal/addons/servicebroker"
	"github.com/pjunak/ttrpg-codex/internal/application/campaigndata"
	sessionauth "github.com/pjunak/ttrpg-codex/internal/auth"
	"github.com/pjunak/ttrpg-codex/internal/events"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/campaignstore"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/migrations"
	"github.com/pjunak/ttrpg-codex/internal/transport/httpapi"
)

const version = "2.0.0-dev"

const (
	hostCompatibilityVersion = "2.0.0"
	addonAPIVersion          = "3.0.0"
	workerProtocolVersion    = "1.0.0"
)

type hostRuntime struct {
	handler  http.Handler
	addons   *packagemanager.Manager
	campaign *campaigndata.Service
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	listenAddress := flag.String("listen", "127.0.0.1:3001", "HTTP listen address")
	dataDirectory := flag.String("data-dir", filepath.Join("data", "rewrite"), "rewrite data directory")
	secureCookies := flag.Bool("secure-cookies", false, "mark session cookies Secure (required behind production TLS)")
	flag.Parse()

	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	databasePath := filepath.Join(*dataDirectory, "codex.db")
	db, err := sqlite.Open(ctx, databasePath)
	if err != nil {
		return fmt.Errorf("open database: %w", err)
	}
	defer db.Close()

	result, err := sqlite.Migrate(ctx, db, migrations.FS)
	if err != nil {
		return fmt.Errorf("migrate database: %w", err)
	}
	logger.Info("database ready", "path", databasePath, "appliedMigrations", result.Applied)

	dmPassword := os.Getenv("CODEX_DM_PASSWORD")
	if dmPassword == "" {
		return errors.New("CODEX_DM_PASSWORD is required; the rewrite has no default credential")
	}
	runtime, err := composeHost(
		ctx, db, *dataDirectory, dmPassword, os.Getenv("CODEX_PLAYER_PASSWORD"),
		*secureCookies, logger,
	)
	if err != nil {
		return err
	}
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := runtime.addons.Shutdown(shutdownCtx); err != nil {
			logger.Error("shut down add-on runtimes", "error", err)
		}
	}()
	server := &http.Server{
		Addr:              *listenAddress,
		Handler:           runtime.handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	serveErrors := make(chan error, 1)
	go func() {
		logger.Info("rewrite host listening", "address", server.Addr, "version", version)
		serveErrors <- server.ListenAndServe()
	}()

	select {
	case err := <-serveErrors:
		if !errors.Is(err, http.ErrServerClosed) {
			return fmt.Errorf("serve HTTP: %w", err)
		}
		return nil
	case <-ctx.Done():
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("shutdown HTTP server: %w", err)
	}
	return nil
}

func composeHost(
	ctx context.Context,
	db *sql.DB,
	dataDirectory string,
	dmPassword string,
	playerPassword string,
	secureCookies bool,
	logger *slog.Logger,
) (*hostRuntime, error) {
	if logger == nil {
		logger = slog.Default()
	}
	authentication, err := sessionauth.New(sessionauth.Config{
		DMPassword: dmPassword, PlayerPassword: playerPassword,
	})
	if err != nil {
		return nil, fmt.Errorf("configure authentication: %w", err)
	}
	eventBroker, err := events.New(events.Config{DB: db})
	if err != nil {
		return nil, fmt.Errorf("configure event broker: %w", err)
	}
	campaignRecords, err := campaignstore.New(campaignstore.Config{
		DB: db, Events: eventBroker,
	})
	if err != nil {
		return nil, fmt.Errorf("configure campaign record store: %w", err)
	}
	campaignData, err := campaigndata.New(campaignRecords)
	if err != nil {
		return nil, fmt.Errorf("configure campaign data service: %w", err)
	}
	inspector, err := packageinspect.New(packageinspect.DefaultLimits)
	if err != nil {
		return nil, fmt.Errorf("configure package inspector: %w", err)
	}
	brokerStore, err := servicebroker.NewStore(db)
	if err != nil {
		return nil, fmt.Errorf("configure service store: %w", err)
	}
	requestContexts, err := requestcontext.New(requestcontext.Config{})
	if err != nil {
		return nil, fmt.Errorf("configure request contexts: %w", err)
	}
	serviceBroker, err := servicebroker.New(
		brokerStore, servicebroker.NewRuntimeDirectory(), requestContexts,
	)
	if err != nil {
		return nil, fmt.Errorf("configure service broker: %w", err)
	}
	addons, err := packagemanager.New(packagemanager.Config{
		DB: db, PackageDirectory: filepath.Join(dataDirectory, "addons"),
		Inspector: inspector, Broker: serviceBroker,
		HostVersion: hostCompatibilityVersion, AddonAPIVersion: addonAPIVersion,
		WorkerProtocolVersion: workerProtocolVersion,
		AvailableCapabilities: []string{"ui.contributions"},
		EventPublisher:        eventBroker, Logger: logger,
	})
	if err != nil {
		return nil, fmt.Errorf("configure package manager: %w", err)
	}
	recovery, err := addons.Recover(ctx)
	if err != nil {
		_ = addons.Shutdown(context.Background())
		return nil, fmt.Errorf("recover add-on generations: %w", err)
	}
	for _, result := range recovery {
		if result.Recovered {
			logger.Info("recovered add-on generation", "addonId", result.AddonID, "generationId", result.GenerationID)
		} else {
			logger.Warn(
				"add-on generation was not recovered",
				"addonId", result.AddonID, "generationId", result.GenerationID,
				"error", result.Error,
			)
		}
	}
	handler, err := httpapi.New(httpapi.Config{
		Version: version, DB: db, Logger: logger,
		Authentication: authentication, SecureCookies: secureCookies,
		CampaignData:   campaignData,
		AddonLifecycle: addons, AdminAuthorizer: httpapi.SessionAdminAuthorizer(authentication),
		BrowserAddons: addons, BrowserAuthorizer: httpapi.SessionBrowserAuthorizer,
		Events: eventBroker, EventAuthorizer: httpapi.SessionEventAuthorizer,
	})
	if err != nil {
		_ = addons.Shutdown(context.Background())
		return nil, fmt.Errorf("configure HTTP API: %w", err)
	}
	return &hostRuntime{handler: handler, addons: addons, campaign: campaignData}, nil
}
