// Package githubsource discovers prebuilt GitHub packages and stages them through
// the host lifecycle. Remote metadata never grants activation authority.
package githubsource

import (
	"context"
	"database/sql"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/addons/packageinspect"
	"github.com/pjunak/ttrpg-codex/internal/addons/packagemanager"
)

var (
	ErrInvalid       = errors.New("invalid GitHub source request")
	ErrConflict      = errors.New("GitHub source or package changed; check again")
	ErrSourceMissing = errors.New("no GitHub repository is linked")
	ErrUnavailable   = errors.New("GitHub request failed; check repository access, token permissions and rate limits")
	ErrNoPackage     = errors.New("no prebuilt package found; publish a release ZIP or a successful workflow artifact")
	ErrPackage       = errors.New("GitHub download must contain one valid Add-on API v3 package ZIP")
	ErrIdentity      = errors.New("downloaded package belongs to a different add-on")
)
var repoPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}$`)
var addonPattern = regexp.MustCompile(`^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`)
var tokenPattern = regexp.MustCompile(`^[\x21-\x7e]{8,255}$`)

type Source struct {
	Repo     string `json:"repo"`
	Channel  string `json:"channel"`
	Branch   string `json:"branch"`
	Artifact string `json:"artifact"`
}
type LinkedSource struct {
	AddonID  string `json:"addonId"`
	Source   Source `json:"source"`
	Revision int64  `json:"revision"`
}
type Candidate struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Version      string `json:"version"`
	Digest       string `json:"digest"`
	Active       bool   `json:"active"`
	downloadPath string
}
type Discovery struct {
	Source     Source      `json:"source"`
	Candidates []Candidate `json:"candidates"`
}
type TokenStatus struct {
	DefaultSource         string   `json:"defaultSource"`
	EnvironmentConfigured bool     `json:"environmentConfigured"`
	Repositories          []string `json:"repositories"`
}
type Status struct {
	ContractVersion string         `json:"contractVersion"`
	Sources         []LinkedSource `json:"sources"`
	Credentials     TokenStatus    `json:"credentials"`
}
type Lifecycle interface {
	StageArchive(context.Context, io.Reader) (packagemanager.Generation, error)
}
type Config struct {
	DB               *sql.DB
	DataDirectory    string
	Lifecycle        Lifecycle
	Inspector        *packageinspect.Inspector
	EnvironmentToken string
}
type Service struct {
	store            *store
	lifecycle        Lifecycle
	inspector        *packageinspect.Inspector
	environmentToken string
	client           *http.Client
}

func New(config Config) (*Service, error) {
	if config.DB == nil || config.DataDirectory == "" || config.Lifecycle == nil || config.Inspector == nil {
		return nil, ErrInvalid
	}
	return &Service{store: &store{db: config.DB, credentialPath: filepath.Join(config.DataDirectory, "credentials", "github.db")}, lifecycle: config.Lifecycle, inspector: config.Inspector,
		environmentToken: strings.TrimSpace(config.EnvironmentToken), client: &http.Client{Timeout: 25 * time.Second, CheckRedirect: githubRedirect}}, nil
}

func NormalizeRepo(raw string) (string, error) {
	repo := strings.TrimSpace(raw)
	if strings.HasPrefix(repo, "https://") {
		u, err := url.Parse(repo)
		if err != nil || u.Host != "github.com" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.RawPath != "" {
			return "", ErrInvalid
		}
		repo = strings.TrimPrefix(u.Path, "/")
	}
	repo = strings.TrimSuffix(strings.TrimSuffix(repo, "/"), ".git")
	if !repoPattern.MatchString(repo) || strings.HasSuffix(repo, "/.") || strings.HasSuffix(repo, "/..") {
		return "", ErrInvalid
	}
	return strings.ToLower(repo), nil
}
func normalizeSource(source Source) (Source, error) {
	repo, err := NormalizeRepo(source.Repo)
	if err != nil {
		return source, err
	}
	source.Repo = repo
	if source.Channel != "release" && source.Channel != "actions" {
		return source, ErrInvalid
	}
	source.Branch = strings.TrimSpace(source.Branch)
	source.Artifact = strings.TrimSpace(source.Artifact)
	if len(source.Branch) > 200 || len(source.Artifact) > 200 || strings.ContainsAny(source.Branch+source.Artifact, "\r\n\x00") {
		return source, ErrInvalid
	}
	if source.Channel == "release" {
		source.Branch = ""
		source.Artifact = ""
	} else if source.Artifact == "" {
		source.Artifact = "reviewed-package"
	}
	return source, nil
}
func validAddonID(id string) bool { return len(id) <= 80 && addonPattern.MatchString(id) }

func (s *Service) Status(ctx context.Context) (Status, error) {
	result := Status{ContractVersion: "addon-github.v1", Credentials: TokenStatus{DefaultSource: "none", EnvironmentConfigured: s.environmentToken != "", Repositories: []string{}}}
	sources, err := s.store.sources(ctx)
	if err != nil {
		return result, err
	}
	result.Sources = sources
	tokens, err := s.store.tokens(ctx)
	if err != nil {
		return result, err
	}
	if s.environmentToken != "" {
		result.Credentials.DefaultSource = "environment"
	}
	if tokens[""] != "" {
		result.Credentials.DefaultSource = "stored"
	}
	for repo := range tokens {
		if repo != "" {
			result.Credentials.Repositories = append(result.Credentials.Repositories, repo)
		}
	}
	sort.Strings(result.Credentials.Repositories)
	return result, nil
}
func (s *Service) SaveToken(ctx context.Context, repo, token string) error {
	var err error
	if strings.TrimSpace(repo) != "" {
		repo, err = NormalizeRepo(repo)
		if err != nil {
			return err
		}
	} else {
		repo = ""
	}
	token = strings.TrimSpace(token)
	if token != "" && !tokenPattern.MatchString(token) {
		return ErrInvalid
	}
	return s.store.saveToken(ctx, repo, token)
}
func (s *Service) token(ctx context.Context, repo string) (string, error) {
	tokens, err := s.store.tokens(ctx)
	if err != nil {
		return "", err
	}
	if token := tokens[repo]; token != "" {
		return token, nil
	}
	if token := tokens[""]; token != "" {
		return token, nil
	}
	return s.environmentToken, nil
}
func (s *Service) SaveSource(ctx context.Context, item LinkedSource, remove bool) error {
	if !validAddonID(item.AddonID) || item.Revision < 0 {
		return ErrInvalid
	}
	if remove {
		return s.store.removeSource(ctx, item.AddonID, item.Revision)
	}
	source, err := normalizeSource(item.Source)
	if err != nil {
		return err
	}
	item.Source = source
	installed, err := s.store.installed(ctx, item.AddonID)
	if err != nil {
		return err
	}
	if !installed {
		return ErrInvalid
	}
	return s.store.saveSource(ctx, item)
}
func (s *Service) Discover(ctx context.Context, source Source, addonID string) (Discovery, error) {
	if addonID != "" && !validAddonID(addonID) {
		return Discovery{}, ErrInvalid
	}
	source, err := normalizeSource(source)
	if err != nil {
		return Discovery{}, err
	}
	if addonID != "" {
		linked, err := s.store.source(ctx, addonID)
		if err != nil {
			return Discovery{}, err
		}
		if linked.Source != source {
			return Discovery{}, ErrConflict
		}
	}
	token, err := s.token(ctx, source.Repo)
	if err != nil {
		return Discovery{}, err
	}
	candidates, err := s.discover(ctx, source, token)
	if err != nil {
		return Discovery{}, err
	}
	for i := range candidates {
		if addonID != "" {
			candidates[i].Active, err = s.store.isActive(ctx, addonID, source, candidates[i].ID)
			if err != nil {
				return Discovery{}, err
			}
		}
	}
	return Discovery{Source: source, Candidates: candidates}, nil
}
func (s *Service) Stage(ctx context.Context, source Source, addonID, candidateID string) (packagemanager.Generation, error) {
	var zero packagemanager.Generation
	if len(candidateID) != 64 || strings.Trim(candidateID, "0123456789abcdef") != "" {
		return zero, ErrInvalid
	}
	// Re-resolve the listing before downloading; client-supplied URLs and stale
	// candidate identifiers never become download authority.
	discovery, err := s.Discover(ctx, source, addonID)
	if err != nil {
		return zero, err
	}
	source = discovery.Source
	var candidate *Candidate
	for i := range discovery.Candidates {
		if discovery.Candidates[i].ID == candidateID {
			candidate = &discovery.Candidates[i]
			break
		}
	}
	if candidate == nil {
		return zero, ErrConflict
	}
	token, err := s.token(ctx, source.Repo)
	if err != nil {
		return zero, err
	}
	file, err := s.download(ctx, *candidate, source.Channel, token)
	if err != nil {
		return zero, err
	}
	defer func() { file.Close(); os.Remove(file.Name()) }()
	report, err := s.inspector.InspectFile(ctx, file.Name())
	if err != nil {
		return zero, ErrPackage
	}
	if addonID != "" && report.Manifest.ID != addonID {
		return zero, ErrIdentity
	}
	existing, sourceErr := s.store.source(ctx, report.Manifest.ID)
	if sourceErr != nil && !errors.Is(sourceErr, ErrSourceMissing) {
		return zero, sourceErr
	}
	if sourceErr == nil && existing.Source != source {
		return zero, ErrConflict
	}
	if _, err = file.Seek(0, io.SeekStart); err != nil {
		return zero, err
	}
	generation, err := s.lifecycle.StageArchive(ctx, file)
	if err != nil {
		return zero, err
	}
	if err := s.store.record(ctx, generation.AddonID, generation.GenerationID, source, candidate.ID); err != nil {
		return zero, err
	}
	if errors.Is(sourceErr, ErrSourceMissing) {
		if err := s.store.saveSource(ctx, LinkedSource{AddonID: generation.AddonID, Source: source}); err != nil {
			return zero, err
		}
	}
	return generation, nil
}
