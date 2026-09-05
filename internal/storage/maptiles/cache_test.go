package maptiles

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestPyramidPreservesNativePixelsEdgesAndCacheReuse(t *testing.T) {
	t.Parallel()
	directory := t.TempDir()
	cache, err := New(directory)
	if err != nil {
		t.Fatal(err)
	}
	source := image.NewNRGBA(image.Rect(0, 0, 513, 257))
	for y := range 257 {
		for x := range 513 {
			source.SetNRGBA(x, y, color.NRGBA{R: uint8(x), G: uint8(y), B: 97, A: 255})
		}
	}
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, source); err != nil {
		t.Fatal(err)
	}
	digest := strings.Repeat("a", 64)
	manifest, err := cache.Ensure(context.Background(), digest, bytes.NewReader(encoded.Bytes()))
	if err != nil || manifest != (Manifest{513, 257, 256, 2}) {
		t.Fatalf("manifest = %+v, %v", manifest, err)
	}
	for _, point := range []image.Point{{0, 0}, {255, 127}, {256, 256}, {512, 256}} {
		file, err := cache.Open(digest, manifest, 2, point.X/256, point.Y/256)
		if err != nil {
			t.Fatal(err)
		}
		tile, err := png.Decode(file)
		file.Close()
		if err != nil {
			t.Fatal(err)
		}
		if tile.Bounds() != image.Rect(0, 0, 257, 257) {
			t.Fatalf("tile bounds = %v", tile.Bounds())
		}
		if got, want := color.NRGBAModel.Convert(tile.At(point.X%256, point.Y%256)), source.NRGBAAt(point.X, point.Y); got != want {
			t.Fatalf("pixel %v = %v, want %v", point, got, want)
		}
		if point == (image.Point{0, 0}) {
			if got, want := color.NRGBAModel.Convert(tile.At(256, 256)), source.NRGBAAt(256, 256); got != want {
				t.Fatalf("overlap pixel = %v, want %v", got, want)
			}
		}
		if point.X == 512 {
			if _, _, _, alpha := tile.At(1, 1).RGBA(); alpha != 0 {
				t.Fatal("edge padding must be transparent")
			}
		}
	}
	for level := range 3 {
		file, err := cache.Open(digest, manifest, level, 0, 0)
		if err != nil {
			t.Fatal(err)
		}
		file.Close()
	}
	if _, err := cache.Open(digest, manifest, 2, 3, 0); !errors.Is(err, ErrNotFound) {
		t.Fatalf("outside tile = %v", err)
	}
	if _, err := cache.Open("../outside", manifest, 2, 0, 0); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unsafe digest = %v", err)
	}
	// A hit must work without decoding the original again, including after restart.
	second, _ := New(directory)
	if got, err := second.Ensure(context.Background(), digest, bytes.NewReader(nil)); err != nil || got != manifest {
		t.Fatalf("cache hit = %+v, %v", got, err)
	}
	if err := os.RemoveAll(filepath.Join(directory, digest)); err != nil {
		t.Fatal(err)
	}
	if _, err := second.Ensure(context.Background(), digest, bytes.NewReader(encoded.Bytes())); err != nil {
		t.Fatal(err)
	}
}

func TestPyramidRejectsUnsupportedAndOversizedImagesBeforeDecode(t *testing.T) {
	t.Parallel()
	cache, _ := New(t.TempDir())
	for index, data := range [][]byte{[]byte("<svg/>"), []byte("GIF89a"), []byte("invalid")} {
		if _, err := cache.Ensure(context.Background(), strings.Repeat(string(rune('a'+index)), 64), bytes.NewReader(data)); !errors.Is(err, ErrUnsupported) {
			t.Fatalf("unsupported = %v", err)
		}
	}
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, image.NewGray(image.Rect(0, 0, MaximumDimension+1, 1))); err != nil {
		t.Fatal(err)
	}
	if _, err := cache.Ensure(context.Background(), strings.Repeat("d", 64), bytes.NewReader(encoded.Bytes())); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("oversize = %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := cache.Ensure(ctx, strings.Repeat("a", 64), bytes.NewReader(nil)); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel = %v", err)
	}
	if (Manifest{32768, 32768, 256, 7}).Valid() {
		t.Fatal("pixel budget accepted oversized dimensions")
	}
}

func TestPyramidConcurrentRequestsPublishOneCompleteGeneration(t *testing.T) {
	t.Parallel()
	directory := t.TempDir()
	cache, _ := New(directory)
	var encoded bytes.Buffer
	png.Encode(&encoded, image.NewNRGBA(image.Rect(0, 0, 600, 300)))
	var group sync.WaitGroup
	for range 4 {
		group.Go(func() {
			manifest, err := cache.Ensure(context.Background(), strings.Repeat("a", 64), bytes.NewReader(encoded.Bytes()))
			if err != nil {
				t.Error(err)
				return
			}
			file, err := cache.Open(strings.Repeat("a", 64), manifest, manifest.Depth, 2, 1)
			if err != nil {
				t.Error(err)
				return
			}
			file.Close()
		})
	}
	group.Wait()
	entries, err := os.ReadDir(directory)
	if err != nil || len(entries) != 1 || entries[0].Name() != strings.Repeat("a", 64) {
		t.Fatalf("cache entries = %v, %v", entries, err)
	}
}

func TestJPEGWithoutOrientationMetadataTilesAndEXIFFallsBack(t *testing.T) {
	t.Parallel()
	cache, _ := New(t.TempDir())
	var encoded bytes.Buffer
	jpeg.Encode(&encoded, image.NewRGBA(image.Rect(0, 0, 20, 15)), nil)
	if _, err := cache.Ensure(context.Background(), strings.Repeat("a", 64), bytes.NewReader(encoded.Bytes())); err != nil {
		t.Fatal(err)
	}
	withEXIF := append([]byte{0xff, 0xd8, 0xff, 0xe1, 0, 8, 'E', 'x', 'i', 'f', 0, 0}, encoded.Bytes()[2:]...)
	if _, err := cache.Ensure(context.Background(), strings.Repeat("b", 64), bytes.NewReader(withEXIF)); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("oriented JPEG = %v", err)
	}
}

func TestWebPAndCancelledGeneration(t *testing.T) {
	t.Parallel()
	directory := t.TempDir()
	cache, _ := New(directory)
	encoded, err := base64.StdEncoding.DecodeString("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA")
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := cache.Ensure(context.Background(), strings.Repeat("a", 64), bytes.NewReader(encoded))
	if err != nil || manifest.Width != 1 || manifest.Height != 1 {
		t.Fatalf("WebP manifest = %+v, %v", manifest, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	source := &cancellingSource{Reader: bytes.NewReader(encoded), cancel: cancel}
	if _, err := cache.Ensure(ctx, strings.Repeat("b", 64), source); err == nil {
		t.Fatal("cancelled generation succeeded")
	}
	entries, err := os.ReadDir(directory)
	if err != nil || len(entries) != 1 || entries[0].Name() != strings.Repeat("a", 64) {
		t.Fatalf("cancelled cache entries = %v, %v", entries, err)
	}
}

type cancellingSource struct {
	*bytes.Reader
	cancel context.CancelFunc
}

func (source *cancellingSource) Read(p []byte) (int, error) {
	n, err := source.Reader.Read(p)
	source.cancel()
	return n, err
}
