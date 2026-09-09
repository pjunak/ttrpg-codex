// Package maptiles builds disposable, versioned pyramids from immutable images.
// Callers must authorize the source handle before every cache read.
package maptiles

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/jpeg"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"regexp"

	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

const TileSize = 256
const MaximumPixels = 32 * 1024 * 1024
const MaximumDimension = 32768

var ErrUnsupported = errors.New("map image cannot be tiled")
var ErrNotFound = errors.New("map tile not found")
var digestPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

type Manifest struct {
	Width    int `json:"width"`
	Height   int `json:"height"`
	TileSize int `json:"tileSize"`
	Depth    int `json:"depth"`
}

type Cache struct {
	directory  string
	generation chan struct{}
}

func New(directory string) (*Cache, error) {
	absolute, err := filepath.Abs(directory)
	if err != nil || directory == "" || filepath.Dir(absolute) == absolute {
		return nil, fmt.Errorf("invalid map tile cache directory")
	}
	if err := os.MkdirAll(absolute, 0o700); err != nil {
		return nil, err
	}
	return &Cache{directory: absolute, generation: make(chan struct{}, 1)}, nil
}

func (cache *Cache) Ensure(ctx context.Context, digest string, source io.ReadSeeker) (Manifest, error) {
	if !digestPattern.MatchString(digest) {
		return Manifest{}, ErrNotFound
	}
	if err := ctx.Err(); err != nil {
		return Manifest{}, err
	}
	root, err := os.OpenRoot(cache.directory)
	if err != nil {
		return Manifest{}, err
	}
	defer root.Close()
	if manifest, ok := readManifest(root, digest); ok {
		return manifest, nil
	}
	// One decoder per host bounds memory even when several maps open together.
	select {
	case cache.generation <- struct{}{}:
	case <-ctx.Done():
		return Manifest{}, ctx.Err()
	}
	defer func() { <-cache.generation }()
	if manifest, ok := readManifest(root, digest); ok {
		return manifest, nil
	}
	if _, err := source.Seek(0, io.SeekStart); err != nil {
		return Manifest{}, err
	}
	config, format, err := image.DecodeConfig(source)
	if err != nil || (format != "png" && format != "jpeg" && format != "webp") ||
		config.Width < 1 || config.Height < 1 || config.Width > MaximumDimension || config.Height > MaximumDimension ||
		int64(config.Width)*int64(config.Height) > MaximumPixels {
		return Manifest{}, ErrUnsupported
	}
	// Go decodes the stored pixels without applying EXIF orientation. Only tile
	// JPEGs whose browser presentation keeps that same coordinate frame.
	if format == "jpeg" && !jpegKeepsOrientation(source) {
		return Manifest{}, ErrUnsupported
	}
	manifest := Manifest{Width: config.Width, Height: config.Height, TileSize: TileSize}
	for size := TileSize; size < max(config.Width, config.Height); size *= 2 {
		manifest.Depth++
	}
	if _, err := source.Seek(0, io.SeekStart); err != nil {
		return Manifest{}, err
	}
	current, _, err := image.Decode(&contextReader{ctx, source})
	if err != nil {
		return Manifest{}, errors.Join(ErrUnsupported, err)
	}
	if current.Bounds().Dx() != config.Width || current.Bounds().Dy() != config.Height {
		return Manifest{}, ErrUnsupported
	}
	stage := ".stage-" + rand.Text()
	if err := root.Mkdir(stage, 0o700); err != nil {
		return Manifest{}, err
	}
	defer root.RemoveAll(stage)
	encoder := png.Encoder{CompressionLevel: png.BestSpeed}
	for level := manifest.Depth; level >= 0; level-- {
		bounds := current.Bounds()
		for y := 0; y < bounds.Dy(); y += TileSize {
			for x := 0; x < bounds.Dx(); x += TileSize {
				if err := ctx.Err(); err != nil {
					return Manifest{}, err
				}
				// The extra right/bottom pixel overlaps the next tile at its true
				// scale, hiding fractional-zoom seams without stretching the map.
				tile := image.NewNRGBA(image.Rect(0, 0, TileSize+1, TileSize+1))
				draw.Draw(tile, tile.Bounds(), current, bounds.Min.Add(image.Pt(x, y)), draw.Src)
				file, err := root.OpenFile(filepath.Join(stage, tileName(level, x/TileSize, y/TileSize)), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
				if err != nil {
					return Manifest{}, err
				}
				encodeErr := encoder.Encode(file, tile)
				closeErr := file.Close()
				if err := errors.Join(encodeErr, closeErr); err != nil {
					return Manifest{}, err
				}
			}
		}
		if level > 0 {
			// Pad odd dimensions instead of stretching them into a smaller frame.
			next := image.NewNRGBA(image.Rect(0, 0, (bounds.Dx()+1)/2, (bounds.Dy()+1)/2))
			draw.ApproxBiLinear.Scale(next, next.Bounds(), current, image.Rect(bounds.Min.X, bounds.Min.Y, bounds.Min.X+next.Bounds().Dx()*2, bounds.Min.Y+next.Bounds().Dy()*2), draw.Src, nil)
			current = next
		}
	}
	if err := ctx.Err(); err != nil {
		return Manifest{}, err
	}
	body, err := json.Marshal(manifest)
	if err != nil {
		return Manifest{}, err
	}
	if err := root.WriteFile(filepath.Join(stage, "manifest.json"), body, 0o600); err != nil {
		return Manifest{}, err
	}
	// Only a complete directory is ever visible to readers. Invalid cache data
	// is disposable; originals and authoritative metadata are outside this root.
	if err := root.RemoveAll(digest); err != nil {
		return Manifest{}, err
	}
	if err := root.Rename(stage, digest); err != nil {
		return Manifest{}, err
	}
	return manifest, nil
}

func (cache *Cache) Open(digest string, manifest Manifest, level, x, y int) (*os.File, error) {
	if !digestPattern.MatchString(digest) || !manifest.Valid() || level < 0 || level > manifest.Depth || x < 0 || y < 0 {
		return nil, ErrNotFound
	}
	scale := 1 << (manifest.Depth - level)
	if x >= (manifest.Width+scale*TileSize-1)/(scale*TileSize) || y >= (manifest.Height+scale*TileSize-1)/(scale*TileSize) {
		return nil, ErrNotFound
	}
	root, err := os.OpenRoot(cache.directory)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	file, err := root.Open(filepath.Join(digest, tileName(level, x, y)))
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		file.Close()
		return nil, ErrNotFound
	}
	return file, nil
}

func (manifest Manifest) Valid() bool {
	if manifest.Width < 1 || manifest.Height < 1 || manifest.Width > MaximumDimension || manifest.Height > MaximumDimension ||
		int64(manifest.Width)*int64(manifest.Height) > MaximumPixels || manifest.TileSize != TileSize || manifest.Depth < 0 || manifest.Depth > 7 {
		return false
	}
	depth := 0
	for size := TileSize; size < max(manifest.Width, manifest.Height); size *= 2 {
		depth++
	}
	return manifest.Depth == depth
}

func readManifest(root *os.Root, digest string) (Manifest, bool) {
	file, err := root.Open(filepath.Join(digest, "manifest.json"))
	if err != nil {
		return Manifest{}, false
	}
	defer file.Close()
	var manifest Manifest
	err = json.NewDecoder(io.LimitReader(file, 1024)).Decode(&manifest)
	return manifest, err == nil && manifest.Valid()
}
func tileName(level, x, y int) string { return fmt.Sprintf("%d-%d-%d.png", level, x, y) }

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (reader *contextReader) Read(p []byte) (int, error) {
	if err := reader.ctx.Err(); err != nil {
		return 0, err
	}
	return reader.reader.Read(p)
}
