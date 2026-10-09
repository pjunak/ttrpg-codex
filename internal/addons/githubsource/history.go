package githubsource

import (
	"context"
	"encoding/json"
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
