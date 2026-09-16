package httpapi

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"path"
	"strconv"
	"time"
)

type compressedAsset struct {
	body        []byte
	contentType string
	etag        string
}

// Hashed build assets are immutable for the life of a host. Prepare their
// compressed representation once, with bounded input and retained memory.
func compressFrontendAssets(files fs.FS) (map[string]compressedAsset, error) {
	const maximumAsset = 8 << 20
	const maximumInput = 32 << 20
	entries, err := fs.ReadDir(files, "assets")
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	assets := make(map[string]compressedAsset)
	total := 0
	for _, entry := range entries {
		contentType := ""
		switch path.Ext(entry.Name()) {
		case ".js":
			contentType = "text/javascript; charset=utf-8"
		case ".css":
			contentType = "text/css; charset=utf-8"
		default:
			continue
		}
		info, err := entry.Info()
		if err != nil {
			return nil, err
		}
		if !info.Mode().IsRegular() || info.Size() < 1024 || info.Size() > maximumAsset ||
			info.Size() > int64(maximumInput-total) {
			continue
		}
		name := path.Join("assets", entry.Name())
		file, err := files.Open(name)
		if err != nil {
			return nil, err
		}
		body, readErr := io.ReadAll(io.LimitReader(file, int64(min(maximumAsset, maximumInput-total))+1))
		closeErr := file.Close()
		if readErr != nil || closeErr != nil {
			return nil, errors.Join(readErr, closeErr)
		}
		if len(body) > maximumAsset || len(body) > maximumInput-total {
			continue
		}
		total += len(body)
		var buffer bytes.Buffer
		writer, _ := gzip.NewWriterLevel(&buffer, gzip.BestCompression)
		_, _ = writer.Write(body)
		if err := writer.Close(); err != nil {
			return nil, err
		}
		if buffer.Len() < len(body) {
			encoded := buffer.Bytes()
			assets["/"+name] = compressedAsset{
				body: encoded, contentType: contentType,
				etag: fmt.Sprintf("\"gzip-%x\"", sha256.Sum256(encoded)),
			}
		}
	}
	return assets, nil
}

func (asset compressedAsset) serve(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", asset.contentType)
	w.Header().Set("Content-Encoding", "gzip")
	w.Header().Set("Content-Length", strconv.Itoa(len(asset.body)))
	w.Header().Set("ETag", asset.etag)
	http.ServeContent(w, r, path.Base(r.URL.Path), time.Time{}, bytes.NewReader(asset.body))
}
