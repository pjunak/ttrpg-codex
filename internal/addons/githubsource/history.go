package githubsource

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"regexp"
	"strconv"

	"github.com/pjunak/ttrpg-codex/internal/addons/packageinspect"
	"github.com/pjunak/ttrpg-codex/internal/addons/packagemanager"
)

func (s *store) recordCandidate(ctx context.Context, addonID, generationID string, source Source, candidate Candidate) error {
	body, err := json.Marshal(source)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO addon_github_generations(addon_id,generation_id,source_json,remote_id,download_path,digest)
 VALUES (?,?,?,?,?,?) ON CONFLICT(addon_id,generation_id,source_json,remote_id)
 DO UPDATE SET download_path=excluded.download_path,digest=excluded.digest`, addonID, generationID, string(body), candidate.ID, candidate.downloadPath, candidate.Digest)
	return err
}

// FetchPackage resolves only a previously inspected generation. The final ZIP
// hash remains the authority even if a remote asset or repository was replaced.
func (s *Service) FetchPackage(ctx context.Context, ref packagemanager.PackageReference, destination string) error {
	for _, locator := range ref.Locators {
		if err := ctx.Err(); err != nil {
			return err
		}
		var source Source
		if json.Unmarshal(locator.Source, &source) != nil {
			continue
		}
		normalized, err := normalizeSource(source)
		if err != nil || normalized != source {
			continue
		}
		token, err := s.token(ctx, source.Repo)
		if err != nil {
			continue
		}
		candidate := Candidate{ID: locator.RemoteID, Digest: locator.Digest, downloadPath: locator.DownloadPath}
		if candidate.downloadPath == "" {
			candidate, err = s.historicalCandidate(ctx, source, locator.RemoteID, token)
			if err != nil {
				continue
			}
		}
		suffix := `/releases/assets/[1-9][0-9]*`
		if source.Channel == "actions" {
			suffix = `/actions/artifacts/[1-9][0-9]*/zip`
		}
		if !regexp.MustCompile("^" + regexp.QuoteMeta("/repos/"+source.Repo) + suffix + "$").MatchString(candidate.downloadPath) {
			continue
		}
		file, err := s.download(ctx, candidate, source.Channel, token)
		if err != nil {
			continue
		}
		err = s.copyHistoricalPackage(ctx, file, ref, destination)
		file.Close()
		os.Remove(file.Name())
		if err == nil {
			return nil
		}
	}
	return packagemanager.ErrPackageUnavailable
}
func (s *Service) copyHistoricalPackage(ctx context.Context, file *os.File, ref packagemanager.PackageReference, destination string) (resultErr error) {
	report, err := s.inspector.InspectFile(ctx, file.Name())
	if err != nil || report.Manifest.ID != ref.AddonID || report.ArchiveSHA256 != ref.GenerationID {
		return ErrPackage
	}
	if _, err = file.Seek(0, io.SeekStart); err != nil {
		return err
	}
	out, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	defer func() {
		out.Close()
		if resultErr != nil {
			os.Remove(destination)
		}
	}()
	n, err := io.Copy(out, io.LimitReader(file, packageinspect.DefaultLimits.MaxArchiveBytes+1))
	if err != nil || n > packageinspect.DefaultLimits.MaxArchiveBytes {
		return ErrPackage
	}
	if err = out.Sync(); err != nil {
		return err
	}
	return out.Close()
}

// Older installations stored an opaque candidate fingerprint without an asset
// path. Search bounded historical metadata once per fetch; never use "latest"
// as a substitute. Expired/deleted assets require the owner's matching ZIP.
func (s *Service) historicalCandidate(ctx context.Context, source Source, id, token string) (Candidate, error) {
	type asset struct {
		ID        int64  `json:"id"`
		Digest    string `json:"digest"`
		UpdatedAt string `json:"updated_at"`
		Expired   bool   `json:"expired"`
	}
	for page := 1; page <= 10; page++ {
		var assets []asset
		count := 0
		if source.Channel == "release" {
			var releases []struct {
				Assets []asset `json:"assets"`
			}
			if err := s.getJSON(ctx, fmt.Sprintf("/repos/%s/releases?per_page=100&page=%d", source.Repo, page), token, &releases); err != nil {
				return Candidate{}, err
			}
			count = len(releases)
			for _, release := range releases {
				assets = append(assets, release.Assets...)
			}
		} else {
			var listing struct {
				Artifacts []asset `json:"artifacts"`
			}
			if err := s.getJSON(ctx, fmt.Sprintf("/repos/%s/actions/artifacts?per_page=100&page=%d", source.Repo, page), token, &listing); err != nil {
				return Candidate{}, err
			}
			assets = listing.Artifacts
			count = len(assets)
		}
		for _, asset := range assets {
			if asset.ID <= 0 || asset.Expired || remoteID(asset.ID, asset.Digest, asset.UpdatedAt) != id {
				continue
			}
			path := "/repos/" + source.Repo + "/releases/assets/" + strconv.FormatInt(asset.ID, 10)
			if source.Channel == "actions" {
				path = "/repos/" + source.Repo + "/actions/artifacts/" + strconv.FormatInt(asset.ID, 10) + "/zip"
			}
			return Candidate{ID: id, Digest: asset.Digest, downloadPath: path}, nil
		}
		if count < 100 {
			break
		}
	}
	return Candidate{}, ErrNoPackage
}
