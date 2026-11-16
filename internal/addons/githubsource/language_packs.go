package githubsource

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"slices"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/addons/packageinspect"
	"github.com/pjunak/ttrpg-codex/internal/addons/packagemanager"
	"github.com/pjunak/ttrpg-codex/internal/events"
)

// Language packs are published as release assets named
// <add-on ID>-<version>.<locale>.langpack.zip beside each package (ADR-0007).
// The host looks for them in the linked repository's recent releases, whatever
// channel the add-on itself is installed from.

const (
	// packReleases bounds how many recent releases one check reads.
	packReleases = 30
	// packAttempts bounds the downloads per add-on and language in one check.
	packAttempts = 4
)

// PackHost stores packs and reports them; packagemanager.Manager implements it.
type PackHost interface {
	LanguagePackTargets(context.Context) ([]packagemanager.LanguagePackTarget, error)
	InstallLanguagePack(context.Context, packagemanager.LanguagePackTarget, string) (packageinspect.PackReport, error)
	RecordLanguagePackCheck(context.Context, packagemanager.LanguagePackCheck)
	RemoveLanguagePacks(context.Context, func(addonID, locale string) bool) error
}

type packAsset struct {
	version   string
	locale    string
	candidate Candidate
}

// listLanguagePacks reads the pack assets of addonID in the newest releases,
// newest first.
func (s *Service) listLanguagePacks(ctx context.Context, repo, token, addonID string) ([]packAsset, error) {
	var releases []struct {
		Draft      bool `json:"draft"`
		Prerelease bool `json:"prerelease"`
		Assets     []struct {
			ID        int64  `json:"id"`
			Name      string `json:"name"`
			State     string `json:"state"`
			Size      int64  `json:"size"`
			Digest    string `json:"digest"`
			UpdatedAt string `json:"updated_at"`
		} `json:"assets"`
	}
	prefix := "/repos/" + repo
	if err := s.getJSON(ctx, prefix+"/releases?per_page="+strconv.Itoa(packReleases), token, &releases); err != nil {
		return nil, err
	}
	result := []packAsset{}
	for _, release := range releases {
		if release.Draft || release.Prerelease {
			continue
		}
		for _, asset := range release.Assets {
			version, locale, ok := packageinspect.ParsePackFileName(asset.Name, addonID)
			if !ok || asset.ID <= 0 || asset.State != "uploaded" || asset.Size <= 0 || asset.Size > packageinspect.MaxPackArchiveBytes {
				continue
			}
			result = append(result, packAsset{version: version, locale: locale, candidate: Candidate{
				ID: remoteID(asset.ID, asset.Digest, asset.UpdatedAt), Name: asset.Name, Version: version, Digest: asset.Digest,
				downloadPath: prefix + "/releases/assets/" + strconv.FormatInt(asset.ID, 10),
			}})
		}
	}
	return result, nil
}

// packErrorCode is the short code the Languages page shows for a failure.
func packErrorCode(err error) string {
	var inspection *packageinspect.InspectionError
	switch {
	case errors.Is(err, ErrRateLimited):
		return "rate-limited"
	case errors.Is(err, ErrTLS):
		return "tls"
	case errors.Is(err, ErrUnavailable), errors.Is(err, ErrConflict):
		return "unavailable"
	case errors.Is(err, ErrPackage), errors.As(err, &inspection), errors.Is(err, packagemanager.ErrLanguagePackMismatch):
		return "invalid"
	default:
		return "storage"
	}
}

// checkLanguagePacks brings one linked add-on's packs for locales up to date:
// for each language it keeps or installs the newest published pack whose
// versions include the active add-on, preferring packs built from that exact
// version. linked is false when the add-on has no GitHub source.
func (s *Service) checkLanguagePacks(ctx context.Context, host PackHost, target packagemanager.LanguagePackTarget, locales []string) (packagemanager.LanguagePackCheck, bool, error) {
	check := packagemanager.LanguagePackCheck{AddonID: target.AddonID, GenerationID: target.GenerationID, Results: map[string]packagemanager.LanguagePackResult{}}
	linked, err := s.store.source(ctx, target.AddonID)
	if errors.Is(err, ErrSourceMissing) {
		return check, false, nil
	}
	if err != nil {
		return check, true, err
	}
	token, err := s.token(ctx, linked.Source.Repo)
	if err != nil {
		return check, true, err
	}
	assets, err := s.listLanguagePacks(ctx, linked.Source.Repo, token, target.AddonID)
	if err != nil {
		for _, locale := range locales {
			check.Results[locale] = packagemanager.LanguagePackResult{Status: packagemanager.PackFailed, Error: packErrorCode(err)}
		}
		return check, true, nil
	}
	for _, asset := range assets {
		check.Available = append(check.Available, asset.locale)
	}
	for _, locale := range locales {
		candidates := []packAsset{}
		for _, asset := range assets {
			if asset.locale == locale {
				candidates = append(candidates, asset)
			}
		}
		// Packs built from the active version first; otherwise newest first.
		sort.SliceStable(candidates, func(left, right int) bool {
			return candidates[left].version == target.Version && candidates[right].version != target.Version
		})
		result, err := s.installLanguagePack(ctx, host, target, token, locale, candidates)
		if errors.Is(err, packagemanager.ErrLanguagePackStale) {
			return check, true, err
		}
		if result != nil {
			check.Results[locale] = *result
		}
	}
	return check, true, nil
}

// installLanguagePack tries candidates in order until one is kept or
// installed; nil means the add-on has a current pack for the language.
func (s *Service) installLanguagePack(ctx context.Context, host PackHost, target packagemanager.LanguagePackTarget, token, locale string, candidates []packAsset) (*packagemanager.LanguagePackResult, error) {
	var failure error
	attempts := 0
	for _, asset := range candidates {
		if stored := target.Packs[locale]; stored != "" && asset.candidate.Digest == "sha256:"+stored {
			return nil, nil
		}
		if attempts == packAttempts {
			break
		}
		attempts++
		file, err := s.download(ctx, asset.candidate, "release", token)
		if err != nil {
			failure = err
			break
		}
		_, err = host.InstallLanguagePack(ctx, target, file.Name())
		file.Close()
		os.Remove(file.Name())
		switch {
		case err == nil:
			return nil, nil
		case errors.Is(err, packagemanager.ErrLanguagePackStale) || ctx.Err() != nil:
			return nil, errors.Join(err, ctx.Err())
		case errors.Is(err, packagemanager.ErrLanguagePackMismatch):
			// Built for other versions of the add-on; an older pack may fit.
			continue
		}
		failure = err
		if packErrorCode(err) == "storage" {
			break
		}
	}
	if failure != nil {
		return &packagemanager.LanguagePackResult{Status: packagemanager.PackFailed, Error: packErrorCode(failure)}, nil
	}
	if target.Packs[locale] != "" {
		// The stored pack still fits and no published pack replaces it.
		return nil, nil
	}
	return &packagemanager.LanguagePackResult{Status: packagemanager.PackNone}, nil
}

// PackSyncConfig wires the language pack checks into the host.
type PackSyncConfig struct {
	Service *Service
	Host    PackHost
	// EnabledLocales reads the site's enabled languages.
	EnabledLocales func(context.Context) ([]string, error)
	// Subscribe, when set, delivers the events that start checks: site
	// language changes, campaign restores and add-on activations.
	Subscribe func() (*events.Subscription, error)
	Logger    *slog.Logger
}

// PackSync keeps every linked add-on's language packs in step with the site's
// enabled languages. Checks run in the background, one at a time, so a slow
// or failing GitHub never delays enabling a language or activating an
// add-on; results appear on the browser graph.
type PackSync struct {
	config  PackSyncConfig
	wake    chan struct{}
	mu      sync.Mutex
	full    bool
	cancel  context.CancelFunc
	done    chan struct{}
	enabled []string
	// checked is the generation each add-on was last checked for; failed
	// marks add-ons whose last check failed, to retry on the next pass.
	checked map[string]string
	failed  map[string]bool
}

func NewPackSync(config PackSyncConfig) (*PackSync, error) {
	if config.Service == nil || config.Host == nil || config.EnabledLocales == nil {
		return nil, ErrInvalid
	}
	if config.Logger == nil {
		config.Logger = slog.Default()
	}
	sync := &PackSync{config: config, wake: make(chan struct{}, 1), checked: map[string]string{}, failed: map[string]bool{}}
	config.Service.packs = sync
	return sync, nil
}

// CheckLanguagePacks asks for a full language pack check now; its results
// reach the browser graph when it finishes.
func (s *Service) CheckLanguagePacks() error {
	if s.packs == nil {
		return ErrInvalid
	}
	s.packs.Request(true)
	return nil
}

// Start runs a full check now and keeps checking in the background until
// Stop or ctx ends.
func (p *PackSync) Start(ctx context.Context) {
	ctx, p.cancel = context.WithCancel(ctx)
	p.done = make(chan struct{})
	p.Request(true)
	var workers sync.WaitGroup
	workers.Go(func() { p.run(ctx) })
	if p.config.Subscribe != nil {
		workers.Go(func() { p.listen(ctx) })
	}
	go func() {
		workers.Wait()
		close(p.done)
	}()
}

// Stop ends background checks and waits for the current one.
func (p *PackSync) Stop() {
	if p.cancel == nil {
		return
	}
	p.cancel()
	<-p.done
}

// Request asks for a check: full re-checks every linked add-on, otherwise
// only add-ons whose active generation changed or whose last check failed.
func (p *PackSync) Request(full bool) {
	p.mu.Lock()
	p.full = p.full || full
	p.mu.Unlock()
	select {
	case p.wake <- struct{}{}:
	default:
	}
}

func (p *PackSync) run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-p.wake:
		}
		p.mu.Lock()
		full := p.full
		p.full = false
		p.mu.Unlock()
		if err := p.Check(ctx, full); err != nil && ctx.Err() == nil {
			p.config.Logger.Warn("language pack check failed", "error", err)
		}
	}
}

func (p *PackSync) listen(ctx context.Context) {
	for ctx.Err() == nil {
		subscription, err := p.config.Subscribe()
		if err != nil {
			p.config.Logger.Warn("language packs cannot follow host events", "error", err)
		} else {
			p.follow(ctx, subscription)
			subscription.Close()
			// Events may have been missed while the subscription was dropped.
			p.Request(false)
		}
		select {
		case <-ctx.Done():
		case <-time.After(5 * time.Second):
		}
	}
}

func (p *PackSync) follow(ctx context.Context, subscription *events.Subscription) {
	for {
		select {
		case <-ctx.Done():
			return
		case event, open := <-subscription.Events:
			if !open {
				return
			}
			if relevantPackEvent(event) {
				p.Request(false)
			}
		}
	}
}

func relevantPackEvent(event events.Event) bool {
	switch event.Topic {
	case "campaign-data-changed":
		return event.ResourceID == "settings"
	case "campaign-restored":
		return true
	case "browser-addons-changed":
		var metadata struct {
			Reason string `json:"reason"`
		}
		return json.Unmarshal(event.Metadata, &metadata) != nil || metadata.Reason != "language-packs"
	}
	return false
}

// Check runs one pass. It removes the packs of languages the site no longer
// enables, then checks linked add-ons: all of them when full or when the
// enabled languages changed, otherwise only those with a new active
// generation or a failed last check.
func (p *PackSync) Check(ctx context.Context, full bool) error {
	enabled, err := p.config.EnabledLocales(ctx)
	if err != nil {
		return err
	}
	locales := []string{}
	for _, locale := range enabled {
		if locale != "en" && packageinspect.LocalePattern.MatchString(locale) {
			locales = append(locales, locale)
		}
	}
	sort.Strings(locales)
	locales = slices.Compact(locales)
	if p.enabled == nil || !slices.Equal(p.enabled, locales) {
		full = true
		if err := p.config.Host.RemoveLanguagePacks(ctx, func(_, locale string) bool {
			return slices.Contains(locales, locale)
		}); err != nil {
			return err
		}
		p.enabled = locales
	}
	targets, err := p.config.Host.LanguagePackTargets(ctx)
	if err != nil {
		return err
	}
	var failures []error
	for _, target := range targets {
		if !full && !p.failed[target.AddonID] && p.checked[target.AddonID] == target.GenerationID {
			continue
		}
		check, linked, err := p.config.Service.checkLanguagePacks(ctx, p.config.Host, target, locales)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if errors.Is(err, packagemanager.ErrLanguagePackStale) {
			// The add-on changed meanwhile; its activation requests a new pass.
			continue
		}
		p.checked[target.AddonID] = target.GenerationID
		p.failed[target.AddonID] = err != nil
		if err != nil {
			failures = append(failures, err)
			continue
		}
		if !linked {
			continue
		}
		for _, result := range check.Results {
			if result.Status == packagemanager.PackFailed {
				p.failed[target.AddonID] = true
			}
		}
		p.config.Host.RecordLanguagePackCheck(ctx, check)
	}
	return errors.Join(failures...)
}
