package githubsource

import (
	"context"
	"net/http"
	"strings"
	"testing"
)

func TestReleaseProvenanceIsBoundedOptionalAndNotCandidateAuthority(t *testing.T) {
	s, _, _ := fixture(t)
	ctx := context.Background()
	source := Source{Repo: "owner/repo", Channel: "release"}
	assetID := int64(1)
	commit := strings.Repeat("a", 40)
	missingCommit := false
	notes := "Fix navigation\r\n<script>untrusted()</script>\x00" + strings.Repeat("🎲", 4100)
	s.client.Transport = transportFunc(func(r *http.Request) (*http.Response, error) {
		switch r.URL.Path {
		case "/repos/owner/repo/releases/latest":
			return response(jsonBody(map[string]any{"tag_name": "release/v1", "target_commitish": "main", "body": notes, "published_at": "2026-09-15T12:00:00+02:00", "assets": []any{map[string]any{"id": assetID, "name": "example.zip", "size": 100, "state": "uploaded", "updated_at": "2026-09-15T10:00:00Z"}}})), nil
		case "/repos/owner/repo/commits/tags/release/v1":
			if missingCommit {
				result := response([]byte("{}"))
				result.StatusCode = http.StatusNotFound
				return result, nil
			}
			return response(jsonBody(map[string]string{"sha": commit})), nil
		default:
			t.Fatalf("metadata check requested non-metadata path: %s", r.URL.Path)
			return nil, ErrUnavailable
		}
	})
	first, err := s.Discover(ctx, source, "")
	if err != nil {
		t.Fatal(err)
	}
	candidate := first.Candidates[0]
	p := candidate.Provenance
	if p == nil || p.Commit != commit || p.PublishedAt != "2026-09-15T10:00:00Z" || !p.NotesTruncated || len([]rune(p.Notes)) != 4000 || strings.Contains(p.Notes, "\x00") || !strings.Contains(p.Notes, "\n<script>") {
		t.Fatalf("incorrect release metadata: %+v", p)
	}
	// A tag/notes edit does not replace the exact asset/digest/time download identity.
	notes = "Changed notes"
	commit = strings.Repeat("b", 40)
	again, err := s.Discover(ctx, source, "")
	if err != nil || again.Candidates[0].ID != candidate.ID || again.Candidates[0].Provenance.Commit != commit {
		t.Fatalf("display metadata became package authority: %+v %v", again, err)
	}
	assetID++
	next, err := s.Discover(ctx, source, "")
	if err != nil || next.Candidates[0].ID == candidate.ID || next.Candidates[0].Version != candidate.Version {
		t.Fatalf("same-tag package replacement lost: %+v %v", next, err)
	}
	missingCommit = true
	fallback, err := s.Discover(ctx, source, "")
	if err != nil || fallback.Candidates[0].Provenance.Commit != "" || fallback.Candidates[0].Provenance.Notes != notes {
		t.Fatalf("optional commit failure hid release: %+v %v", fallback, err)
	}
}

func TestMalformedOptionalProvenanceIsNotDisplayedAsIdentity(t *testing.T) {
	for _, value := range []string{"main", "abc123", "https://example.test/secret", strings.Repeat("z", 40)} {
		if displayCommit(value) != "" {
			t.Fatal("invalid commit displayed")
		}
	}
	if displayTime("not a date") != "" {
		t.Fatal("invalid time displayed")
	}
	notes, truncated := releaseNotes(" \r\n ")
	if notes != "" || truncated {
		t.Fatal("empty release notes not normalized")
	}
}
