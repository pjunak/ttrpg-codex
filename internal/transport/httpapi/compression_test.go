package httpapi

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/pjunak/ttrpg-codex/internal/application/campaigndata"
	sessionauth "github.com/pjunak/ttrpg-codex/internal/auth"
	"github.com/pjunak/ttrpg-codex/internal/domain/campaign"
)

func TestEncodingNegotiationRespectsExclusionsAndPreferences(t *testing.T) {
	for _, test := range []struct {
		header                      string
		available, gzip, acceptable bool
	}{
		{"", true, false, true},
		{"br", true, false, true},
		{"gzip, br", true, true, true},
		{"GZIP; Q=0.5", true, true, true},
		{"gzip;q=0, *;q=1", true, false, true},
		{"*;q=0.7", true, true, true},
		{"*;q=0", true, false, false},
		{"gzip;q=1, *;q=0", true, true, true},
		{"gzip;q=0.5, identity;q=1", true, false, true},
		{"gzip;q=1, identity;q=0.5", true, true, true},
		{"gzip;q=0, identity;q=0", true, false, false},
		{"gzip;q=wat", true, false, true},
		{"gzip;q=1.1", true, false, true},
		{"gzip;q=0.0001", true, false, true},
		{"gzip;q=1; q=0", true, false, true},
		{"gzip;q=0, gzip;q=1", true, false, true},
		{"gzip", false, false, true},
		{"gzip, identity;q=0", false, false, false},
		{"*;q=0, identity;q=1", false, false, true},
	} {
		t.Run(test.header+strconv.FormatBool(test.available), func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "/", nil)
			request.Header.Set("Accept-Encoding", test.header)
			compressed, acceptable := negotiateGzip(request, test.available)
			if compressed != test.gzip || acceptable != test.acceptable {
				t.Fatalf("negotiation = %t, %t", compressed, acceptable)
			}
		})
	}
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.Header.Add("Accept-Encoding", "br")
	request.Header.Add("Accept-Encoding", "gzip;q=1")
	if compressed, acceptable := negotiateGzip(request, true); !compressed || !acceptable {
		t.Fatal("ignored a separate Accept-Encoding field")
	}
}

func decodedGzip(t *testing.T, body []byte) []byte {
	t.Helper()
	reader, err := gzip.NewReader(bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	decoded, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	return decoded
}

type compressionRepository struct {
	campaigndata.Repository
	snapshot campaign.Snapshot
}

func (repository compressionRepository) Snapshot(context.Context, bool) (campaign.Snapshot, error) {
	return repository.snapshot, nil
}

func TestCompressedCampaignPreservesEffectiveProjectionAndNeverCachesIt(t *testing.T) {
	public, _ := json.Marshal(map[string]any{"id": "public", "name": "Public witness", "description": strings.Repeat("Campaign story. ", 500)})
	service, err := campaigndata.New(compressionRepository{snapshot: campaign.Snapshot{
		States: []campaign.CollectionState{{Collection: campaign.Characters, Shape: campaign.List, Materialized: true, Revision: 1}},
		Records: []campaign.Record{
			{Collection: campaign.Characters, Key: "public", Value: public, Visibility: campaign.VisibilityPublic, Revision: 1},
			{Collection: campaign.Characters, Key: "private", Value: json.RawMessage(`{"id":"private","name":"Hidden DM witness"}`), Visibility: campaign.VisibilityDM, Revision: 1},
		},
	}})
	if err != nil {
		t.Fatal(err)
	}
	handler := campaignHandler(t, service)
	for _, test := range []struct {
		name    string
		actor   *sessionauth.Actor
		private bool
	}{
		{"anonymous", nil, false},
		{"player", &sessionauth.Actor{SessionID: "player", RealRole: sessionauth.RolePlayer, Role: sessionauth.RolePlayer}, false},
		{"preview", &sessionauth.Actor{SessionID: "dm", RealRole: sessionauth.RoleDM, Role: sessionauth.RolePlayer}, false},
		{"dm", &sessionauth.Actor{SessionID: "dm", RealRole: sessionauth.RoleDM, Role: sessionauth.RoleDM}, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			var original []byte
			for _, encoding := range []string{"identity", "gzip"} {
				request := httptest.NewRequest(http.MethodGet, "/api/campaign", nil)
				request.Header.Set("Accept-Encoding", encoding)
				if test.actor != nil {
					request = request.WithContext(sessionauth.WithActor(request.Context(), *test.actor))
				}
				response := httptest.NewRecorder()
				handler.ServeHTTP(response, request)
				body := response.Body.Bytes()
				if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" ||
					response.Header().Get("Vary") != "Accept-Encoding" || response.Header().Get("ETag") != "" {
					t.Fatalf("response = %d %v", response.Code, response.Header())
				}
				if encoding == "gzip" {
					if response.Header().Get("Content-Encoding") != "gzip" || len(body) >= len(original) {
						t.Fatal("campaign was not compressed")
					}
					body = decodedGzip(t, body)
					if !bytes.Equal(body, original) {
						t.Fatal("compression changed the projected response")
					}
				} else {
					original = append([]byte(nil), body...)
				}
				if strings.Contains(string(body), "Hidden DM witness") != test.private {
					t.Fatalf("incorrect projection for %s", test.name)
				}
			}
		})
	}
	rejected := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/campaign", nil)
	request.Header.Set("Accept-Encoding", "gzip;q=0, identity;q=0")
	handler.ServeHTTP(rejected, request)
	if rejected.Code != http.StatusNotAcceptable || strings.Contains(rejected.Body.String(), "witness") {
		t.Fatal("ignored encoding exclusion")
	}
	head := httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodHead, "/api/campaign", nil)
	request.Header.Set("Accept-Encoding", "gzip")
	handler.ServeHTTP(head, request)
	if head.Code != http.StatusOK || head.Body.Len() != 0 || head.Header().Get("Content-Encoding") != "gzip" {
		t.Fatal("invalid HEAD response")
	}
}

func TestFrontendCompressedAssetsPreserveCachingHeadAndIdentityRanges(t *testing.T) {
	body := []byte(strings.Repeat("export const story = 'A campaign story';\n", 200))
	handler, err := New(Config{Frontend: fstest.MapFS{
		"index.html":          &fstest.MapFile{Data: []byte("<title>Codex</title>")},
		"assets/app-hash.js":  &fstest.MapFile{Data: body},
		"assets/app-hash.css": &fstest.MapFile{Data: []byte(strings.Repeat(".panel { color: blue; }", 200))},
		"assets/font.woff2":   &fstest.MapFile{Data: body},
	}})
	if err != nil {
		t.Fatal(err)
	}
	fetch := func(method, path, encoding, etag, byteRange string) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(method, path, nil)
		request.Header.Set("Accept-Encoding", encoding)
		if etag != "" {
			request.Header.Set("If-None-Match", etag)
		}
		if byteRange != "" {
			request.Header.Set("Range", byteRange)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}
	response := fetch(http.MethodGet, "/assets/app-hash.js", "gzip", "", "")
	if response.Code != http.StatusOK || response.Header().Get("Content-Encoding") != "gzip" ||
		!strings.Contains(response.Header().Get("Content-Type"), "javascript") ||
		response.Header().Get("Vary") != "Accept-Encoding" ||
		response.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" ||
		!bytes.Equal(decodedGzip(t, response.Body.Bytes()), body) {
		t.Fatal("invalid compressed asset")
	}
	etag := response.Header().Get("ETag")
	if etag == "" {
		t.Fatal("missing representation validator")
	}
	head := fetch(http.MethodHead, "/assets/app-hash.js", "gzip", "", "")
	if head.Body.Len() != 0 || head.Header().Get("Content-Length") != strconv.Itoa(response.Body.Len()) ||
		head.Header().Get("Content-Encoding") != "gzip" {
		t.Fatal("invalid compressed HEAD")
	}
	cached := fetch(http.MethodGet, "/assets/app-hash.js", "gzip", etag, "")
	if cached.Code != http.StatusNotModified || cached.Body.Len() != 0 {
		t.Fatal("conditional compressed request did not revalidate")
	}
	identity := fetch(http.MethodGet, "/assets/app-hash.js", "gzip;q=0", etag, "")
	if identity.Code != http.StatusOK || identity.Header().Get("Content-Encoding") != "" ||
		!bytes.Equal(identity.Body.Bytes(), body) || identity.Header().Get("Vary") != "Accept-Encoding" {
		t.Fatal("incorrect identity variant")
	}
	ranged := fetch(http.MethodGet, "/assets/app-hash.js", "gzip", "", "bytes=0-9")
	if ranged.Code != http.StatusPartialContent || ranged.Header().Get("Content-Encoding") != "" ||
		!bytes.Equal(ranged.Body.Bytes(), body[:10]) {
		t.Fatal("range no longer addresses identity bytes")
	}
	if got := fetch(http.MethodGet, "/assets/app-hash.js", "gzip, identity;q=0", "", "bytes=0-9"); got.Code != http.StatusNotAcceptable {
		t.Fatal("ignored identity exclusion for range")
	}
	css := fetch(http.MethodGet, "/assets/app-hash.css", "gzip", "", "")
	if css.Header().Get("Content-Encoding") != "gzip" || !strings.Contains(css.Header().Get("Content-Type"), "text/css") {
		t.Fatal("CSS was not compressed with its original media type")
	}
	font := fetch(http.MethodGet, "/assets/font.woff2", "gzip", "", "")
	if font.Header().Get("Content-Encoding") != "" || !bytes.Equal(font.Body.Bytes(), body) {
		t.Fatal("compressed an excluded binary type")
	}
	missing := fetch(http.MethodGet, "/assets/missing.js", "gzip", "", "")
	if missing.Code != http.StatusNotFound || missing.Header().Get("Content-Encoding") != "" {
		t.Fatal("compressed or exposed a missing file")
	}
}

func TestFrontendCompressionSkipsOversizedAssets(t *testing.T) {
	assets, err := compressFrontendAssets(fstest.MapFS{"assets/huge.js": &fstest.MapFile{Data: make([]byte, (8<<20)+1)}})
	if err != nil || len(assets) != 0 {
		t.Fatalf("oversized compression = %v, %v", assets, err)
	}
}
