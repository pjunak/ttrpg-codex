package githubsource

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/pjunak/ttrpg-codex/internal/addons/packageinspect"
)

func githubRedirect(req *http.Request, via []*http.Request) error {
	req.Header.Del("Authorization")
	req.Header.Del("Cookie")
	host := req.URL.Hostname()
	allowed := host == "release-assets.githubusercontent.com" || host == "objects.githubusercontent.com" ||
		strings.HasSuffix(host, ".actions.githubusercontent.com") || strings.HasSuffix(host, ".blob.core.windows.net")
	if len(via) >= 5 || req.URL.Scheme != "https" || req.URL.User != nil || req.URL.Port() != "" || !allowed {
		return ErrUnavailable
	}
	return nil
}

func (s *Service) request(ctx context.Context, path, token, accept string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.github.com"+path, nil)
	if err != nil {
		return nil, ErrUnavailable
	}
	req.Header.Set("Accept", accept)
	req.Header.Set("User-Agent", "TTRPG-Codex")
	req.Header.Set("X-GitHub-Api-Version", "2026-03-10")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := s.client.Do(req)
	// Do not propagate transport errors: they can include signed redirect URLs.
	if err != nil {
		var verification *tls.CertificateVerificationError
		if errors.As(err, &verification) {
			return nil, ErrTLS
		}
		return nil, ErrUnavailable
	}
	if res.StatusCode != http.StatusOK {
		res.Body.Close()
		return nil, ErrUnavailable
	}
	return res, nil
}
func (s *Service) getJSON(ctx context.Context, path, token string, result any) error {
	res, err := s.request(ctx, path, token, "application/vnd.github+json")
	if err != nil {
		return err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, (4<<20)+1))
	if err != nil || len(body) > 4<<20 || json.Unmarshal(body, result) != nil {
		return ErrUnavailable
	}
	return nil
}

func remoteID(id int64, digest, updatedAt string) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%d:%s:%s", id, digest, updatedAt)))
	return hex.EncodeToString(sum[:])
}

func (s *Service) discover(ctx context.Context, source Source, token string) ([]Candidate, error) {
	prefix := "/repos/" + source.Repo
	if source.Channel == "release" {
		var release struct {
			Tag         string `json:"tag_name"`
			Body        string `json:"body"`
			PublishedAt string `json:"published_at"`
			Draft       bool   `json:"draft"`
			Prerelease  bool   `json:"prerelease"`
			Assets      []struct {
				ID        int64  `json:"id"`
				Name      string `json:"name"`
				State     string `json:"state"`
				Size      int64  `json:"size"`
				Digest    string `json:"digest"`
				UpdatedAt string `json:"updated_at"`
			} `json:"assets"`
		}
		if err := s.getJSON(ctx, prefix+"/releases/latest", token, &release); err != nil {
			return nil, err
		}
		if release.Draft || release.Prerelease {
			return nil, ErrNoPackage
		}
		provenance := &Provenance{PublishedAt: displayTime(release.PublishedAt)}
		provenance.Notes, provenance.NotesTruncated = releaseNotes(release.Body)
		// target_commitish may be a branch, or stale after a tag move. Resolve
		// the tag itself; optional provenance failure must not hide packages.
		if release.Tag != "" && len(release.Tag) <= 300 {
			var commit struct {
				SHA string `json:"sha"`
			}
			lookup, cancel := context.WithTimeout(ctx, 3*time.Second)
			lookupErr := s.getJSON(lookup, prefix+"/commits/"+url.PathEscape("tags/"+release.Tag), token, &commit)
			cancel()
			if lookupErr == nil {
				provenance.Commit = displayCommit(commit.SHA)
			}
		}
		candidates := []Candidate{}
		for _, asset := range release.Assets {
			if asset.ID <= 0 || asset.State != "uploaded" || !strings.HasSuffix(strings.ToLower(asset.Name), ".zip") || asset.Size <= 0 || asset.Size > packageinspect.DefaultLimits.MaxArchiveBytes {
				continue
			}
			candidates = append(candidates, Candidate{ID: remoteID(asset.ID, asset.Digest, asset.UpdatedAt), Name: asset.Name, Version: release.Tag, Digest: asset.Digest, Provenance: provenance,
				downloadPath: prefix + "/releases/assets/" + strconv.FormatInt(asset.ID, 10)})
		}
		if len(candidates) == 0 {
			return nil, ErrNoPackage
		}
		return candidates, nil
	}
	var repository struct {
		ID            int64  `json:"id"`
		DefaultBranch string `json:"default_branch"`
	}
	if err := s.getJSON(ctx, prefix, token, &repository); err != nil {
		return nil, err
	}
	branch := source.Branch
	if branch == "" {
		branch = repository.DefaultBranch
	}
	if repository.ID <= 0 || branch == "" {
		return nil, ErrUnavailable
	}
	var runs struct {
		Runs []struct {
			ID         int64  `json:"id"`
			Event      string `json:"event"`
			Status     string `json:"status"`
			Conclusion string `json:"conclusion"`
			Branch     string `json:"head_branch"`
			SHA        string `json:"head_sha"`
			RunAttempt int    `json:"run_attempt"`
			CreatedAt  string `json:"created_at"`
			Repository struct {
				ID int64 `json:"id"`
			} `json:"head_repository"`
		} `json:"workflow_runs"`
	}
	if err := s.getJSON(ctx, prefix+"/actions/runs?branch="+url.QueryEscape(branch)+"&status=success&per_page=30", token, &runs); err != nil {
		return nil, err
	}
	checked := 0
	for _, run := range runs.Runs {
		// Never select pull-request/fork packages or unfinished runs. Follow the
		// newest successful push/manual build containing this named artifact.
		if run.ID <= 0 || run.Status != "completed" || run.Conclusion != "success" || run.Branch != branch || run.Repository.ID != repository.ID || (run.Event != "push" && run.Event != "workflow_dispatch") {
			continue
		}
		checked++
		if checked > 10 {
			break
		}
		var listing struct {
			Artifacts []struct {
				ID        int64  `json:"id"`
				Name      string `json:"name"`
				Expired   bool   `json:"expired"`
				Size      int64  `json:"size_in_bytes"`
				Digest    string `json:"digest"`
				UpdatedAt string `json:"updated_at"`
			} `json:"artifacts"`
		}
		if err := s.getJSON(ctx, prefix+"/actions/runs/"+strconv.FormatInt(run.ID, 10)+"/artifacts?per_page=100", token, &listing); err != nil {
			return nil, err
		}
		candidates := []Candidate{}
		for _, artifact := range listing.Artifacts {
			if artifact.ID <= 0 || artifact.Name != source.Artifact || artifact.Expired || artifact.Size <= 0 || artifact.Size > packageinspect.DefaultLimits.MaxArchiveBytes+(1<<20) {
				continue
			}
			candidates = append(candidates, Candidate{ID: remoteID(artifact.ID, artifact.Digest, artifact.UpdatedAt), Name: artifact.Name, Version: run.SHA, Digest: artifact.Digest,
				Provenance:   &Provenance{Commit: displayCommit(run.SHA), RunID: strconv.FormatInt(run.ID, 10), RunAttempt: max(0, min(run.RunAttempt, 1_000_000)), PublishedAt: displayTime(run.CreatedAt)},
				downloadPath: prefix + "/actions/artifacts/" + strconv.FormatInt(artifact.ID, 10) + "/zip"})
		}
		if len(candidates) > 0 {
			return candidates, nil
		}
	}
	return nil, ErrNoPackage
}

var commitPattern = regexp.MustCompile(`^(?:[a-f0-9]{40}|[a-f0-9]{64})$`)

func displayCommit(value string) string {
	if commitPattern.MatchString(value) {
		return value
	}
	return ""
}
func displayTime(value string) string {
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return ""
	}
	return parsed.UTC().Format(time.RFC3339)
}
func releaseNotes(value string) (string, bool) {
	value = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) && r != '\n' && r != '\t' {
			return -1
		}
		return r
	}, strings.ReplaceAll(value, "\r\n", "\n"))
	runes := []rune(strings.TrimSpace(value))
	if len(runes) > 4000 {
		return string(runes[:4000]), true
	}
	return string(runes), false
}

func (s *Service) download(ctx context.Context, candidate Candidate, channel, token string) (_ *os.File, resultErr error) {
	response, err := s.request(ctx, candidate.downloadPath, token, "application/octet-stream")
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	limit := packageinspect.DefaultLimits.MaxArchiveBytes
	if channel == "actions" {
		limit += 1 << 20
	}
	if response.ContentLength > limit {
		return nil, ErrPackage
	}
	file, err := os.CreateTemp("", "codex-github-*.zip")
	if err != nil {
		return nil, err
	}
	defer func() {
		if resultErr != nil {
			file.Close()
			os.Remove(file.Name())
		}
	}()
	hash := sha256.New()
	size, err := io.Copy(io.MultiWriter(file, hash), io.LimitReader(response.Body, limit+1))
	if err != nil || size == 0 || size > limit {
		return nil, ErrPackage
	}
	if candidate.Digest != "" && candidate.Digest != "sha256:"+hex.EncodeToString(hash.Sum(nil)) {
		return nil, ErrConflict
	}
	if channel == "release" {
		return file, nil
	}
	archive, err := zip.NewReader(file, size)
	if err != nil || len(archive.File) > 100 {
		return nil, ErrPackage
	}
	var entry *zip.File
	for _, item := range archive.File {
		if item.FileInfo().IsDir() {
			continue
		}
		if entry != nil || !item.Mode().IsRegular() || !strings.HasSuffix(strings.ToLower(item.Name), ".zip") || item.UncompressedSize64 > uint64(packageinspect.DefaultLimits.MaxArchiveBytes) {
			return nil, ErrPackage
		}
		entry = item
	}
	if entry == nil {
		return nil, ErrPackage
	}
	reader, err := entry.Open()
	if err != nil {
		return nil, ErrPackage
	}
	defer reader.Close()
	inner, err := os.CreateTemp("", "codex-github-package-*.zip")
	if err != nil {
		return nil, err
	}
	n, copyErr := io.Copy(inner, io.LimitReader(reader, packageinspect.DefaultLimits.MaxArchiveBytes+1))
	if copyErr != nil || n == 0 || n > packageinspect.DefaultLimits.MaxArchiveBytes {
		inner.Close()
		os.Remove(inner.Name())
		return nil, ErrPackage
	}
	file.Close()
	os.Remove(file.Name())
	return inner, nil
}
