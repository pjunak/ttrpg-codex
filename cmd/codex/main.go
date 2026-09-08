package main

import (
	"context"
	"database/sql"
	"errors"
	"flag"
	"fmt"
	"io/fs"
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
	"github.com/pjunak/ttrpg-codex/internal/addons/workerbroker"
	"github.com/pjunak/ttrpg-codex/internal/addons/workerhost"
	"github.com/pjunak/ttrpg-codex/internal/addons/workersupervisor"
	"github.com/pjunak/ttrpg-codex/internal/application/addondata"
	"github.com/pjunak/ttrpg-codex/internal/application/campaigndata"
	applicationmedia "github.com/pjunak/ttrpg-codex/internal/application/media"
	sessionauth "github.com/pjunak/ttrpg-codex/internal/auth"
	"github.com/pjunak/ttrpg-codex/internal/backuparchive"
	"github.com/pjunak/ttrpg-codex/internal/events"
	"github.com/pjunak/ttrpg-codex/internal/maintenance/processlock"
	"github.com/pjunak/ttrpg-codex/internal/storage/blobstore"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/addondatastore"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/campaignstore"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/credentialstore"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/mediastore"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/migrations"
	"github.com/pjunak/ttrpg-codex/internal/transport/httpapi"
	"github.com/pjunak/ttrpg-codex/sdk/go/workerrpc"
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
	webDirectory := flag.String("web-dir", filepath.Join("frontend", "dist"), "built TypeScript frontend directory")
	secureCookies := flag.Bool("secure-cookies", false, "mark session cookies Secure (required behind production TLS)")
	locale := flag.String("locale", "en", "BCP 47 locale reported to add-on workers")
	timeZone := flag.String("time-zone", "UTC", "IANA time zone reported to add-on workers")
	resetPasswords := flag.Bool("reset-passwords", false, "offline: replace stored passwords from CODEX_DM_PASSWORD and optional CODEX_PLAYER_PASSWORD, then exit")
	flag.Parse()

	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	dataLock, err := processlock.AcquireHost(*dataDirectory)
	if err != nil {
		return fmt.Errorf("acquire data directory: %w", err)
	}
	defer dataLock.Close()
	if err := backuparchive.Recover(ctx, *dataDirectory, migrations.FS); err != nil {
		return fmt.Errorf("recover database restore: %w", err)
	}

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
	if *resetPasswords {
		if err := sessionauth.ResetCredentials(ctx, credentialstore.Store{DB: db}, dmPassword, os.Getenv("CODEX_PLAYER_PASSWORD")); err != nil {
			return fmt.Errorf("reset passwords: %w", err)
		}
		logger.Info("passwords reset; start the host normally")
		return nil
	}
	runtime, err := composeHost(
		ctx, db, *dataDirectory, dmPassword, os.Getenv("CODEX_PLAYER_PASSWORD"),
		*secureCookies, *locale, *timeZone, logger, os.DirFS(*webDirectory),
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
	locale string,
	timeZone string,
	logger *slog.Logger,
	frontend fs.FS,
) (*hostRuntime, error) {
	if logger == nil {
		logger = slog.Default()
	}
	authentication, err := sessionauth.New(sessionauth.Config{
		DMPassword: dmPassword, PlayerPassword: playerPassword,
		Context: ctx, CredentialStore: credentialstore.Store{DB: db},
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
	addonRecords, err := addondatastore.New(addondatastore.Config{DB: db, Events: eventBroker})
	if err != nil {
		return nil, fmt.Errorf("configure add-on data store: %w", err)
	}
	addonData, err := addondata.New(addonRecords, campaignRecords)
	if err != nil {
		return nil, fmt.Errorf("configure add-on data service: %w", err)
	}
	blobStorage, err := blobstore.New(
		db, filepath.Join(dataDirectory, "blobs"), blobstore.Options{},
	)
	if err != nil {
		return nil, fmt.Errorf("configure blob storage: %w", err)
	}
	mediaAssets, err := mediastore.New(db)
	if err != nil {
		return nil, fmt.Errorf("configure media asset store: %w", err)
	}
	mediaService, err := applicationmedia.New(applicationmedia.Config{
		Blobs: blobStorage, Assets: mediaAssets, Records: campaignRecords,
		MapTileDirectory: filepath.Join(dataDirectory, "cache", "map-tiles-v1"),
	})
	if err != nil {
		return nil, fmt.Errorf("configure media service: %w", err)
	}
	backupArchives := &backuparchive.Creator{
		Database: db, DataDirectory: dataDirectory, HostVersion: version,
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
	runtimeFactory, err := packagemanager.NewSupervisorFactory(packagemanager.SupervisorFactoryConfig{
		Host: workersupervisor.HostInfo{
			Version: version, Locale: locale, TimeZone: timeZone,
		},
		ProtocolVersion: workerProtocolVersion,
		HandlerFactory: packagemanager.WorkerHandlerFactoryFunc(func(
			spec packagemanager.RuntimeSpec,
		) (workerrpc.RequestHandler, error) {
			return workerhost.New(workerhost.Config{
				AddonID: spec.Identity.AddonID, Generation: spec.Identity.Generation,
				Manifest: spec.Manifest, Data: addonData,
				Services: serviceBroker, BoundServices: spec.BoundServices,
				ContextResolver: requestContexts,
				OnInternalError: func(invocation workerbroker.Invocation, cause error) {
					logger.Error("worker host method failed",
						"addonId", invocation.AddonID, "generationId", invocation.Generation,
						"method", invocation.Method, "error", cause,
					)
				},
			})
		}),
		Logger: logger,
	})
	if err != nil {
		return nil, fmt.Errorf("configure native worker runtime: %w", err)
	}
	addons, err := packagemanager.New(packagemanager.Config{
		DB: db, PackageDirectory: filepath.Join(dataDirectory, "addons"),
		Inspector: inspector, Broker: serviceBroker, DataLifecycle: addonData,
		RuntimeFactory: runtimeFactory,
		HostVersion:    hostCompatibilityVersion, AddonAPIVersion: addonAPIVersion,
		WorkerProtocolVersion: workerProtocolVersion,
		AvailableCapabilities: []string{"data.transactions", "ui.contributions", "worker.native"},
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
		CampaignData:             campaignData,
		CampaignMutations:        campaignData,
		CampaignWriter:           httpapi.SessionCampaignMutationAuthorizer(authentication),
		CampaignTwins:            campaignData,
		CampaignTwinWriter:       httpapi.SessionCampaignTwinAuthorizer(authentication),
		CampaignEnums:            campaignData,
		CampaignEnumWriter:       httpapi.SessionCampaignTwinAuthorizer(authentication),
		BackupArchives:           backupArchives,
		BackupAuthorizer:         httpapi.SessionAdminAuthorizer(authentication),
		Media:                    mediaService,
		MediaAuthorizer:          httpapi.SessionMediaAuthorizer(authentication),
		AddonData:                addonData,
		AddonDataAuthorizer:      httpapi.SessionAddonDataAuthorizer(authentication),
		AddonContent:             addons,
		ContentAuthorizer:        httpapi.SessionBrowserAuthorizer,
		BrowserServices:          addons,
		BrowserServiceAuthorizer: httpapi.SessionBrowserServiceAuthorizer(authentication),
		AddonLifecycle:           addons, AdminAuthorizer: httpapi.SessionAdminAuthorizer(authentication),
		BrowserAddons: addons, BrowserAuthorizer: httpapi.SessionBrowserAuthorizer,
		Events: eventBroker, EventAuthorizer: httpapi.SessionEventAuthorizer,
		Frontend: frontend,
	})
	if err != nil {
		_ = addons.Shutdown(context.Background())
		return nil, fmt.Errorf("configure HTTP API: %w", err)
	}
	return &hostRuntime{handler: handler, addons: addons, campaign: campaignData}, nil
}
