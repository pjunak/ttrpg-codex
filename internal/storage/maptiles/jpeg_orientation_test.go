package maptiles

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"strings"
	"testing"
)

func TestJPEGMetadataPreservesNativeTileGeometryAndPixels(t *testing.T) {
	t.Parallel()
	source := image.NewNRGBA(image.Rect(0, 0, 20, 15))
	for y := range 15 {
		for x := range 20 {
			source.SetNRGBA(x, y, color.NRGBA{R: uint8(x * 11), G: uint8(y * 17), B: 70, A: 255})
		}
	}
	var encoded bytes.Buffer
	if err := jpeg.Encode(&encoded, source, nil); err != nil {
		t.Fatal(err)
	}
	decoded, err := jpeg.Decode(bytes.NewReader(encoded.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	for _, endian := range []string{"II", "MM"} {
		for _, orientation := range []uint16{0, 1, 2, 3, 4, 5, 6, 7, 8, 9} {
			t.Run(fmt.Sprintf("%s/orientation-%d", endian, orientation), func(t *testing.T) {
				cache, err := New(t.TempDir())
				if err != nil {
					t.Fatal(err)
				}
				data := withJPEGAPP1(encoded.Bytes(), exifFixture(endian, orientation))
				digest := strings.Repeat("a", 64)
				manifest, err := cache.Ensure(context.Background(), digest, bytes.NewReader(data))
				if orientation > 1 {
					if !errors.Is(err, ErrUnsupported) {
						t.Fatalf("transformed JPEG = %v", err)
					}
					return
				}
				if err != nil || manifest.Width != 20 || manifest.Height != 15 || manifest.Depth != 0 {
					t.Fatalf("untransformed JPEG manifest = %+v, %v", manifest, err)
				}
				file, err := cache.Open(digest, manifest, 0, 0, 0)
				if err != nil {
					t.Fatal(err)
				}
				defer file.Close()
				tile, err := png.Decode(file)
				if err != nil {
					t.Fatal(err)
				}
				for y := range 15 {
					for x := range 20 {
						want := color.NRGBAModel.Convert(decoded.At(x, y))
						if got := color.NRGBAModel.Convert(tile.At(x, y)); got != want {
							t.Fatalf("pixel %d,%d = %v, want %v", x, y, got, want)
						}
					}
				}
			})
		}
	}
}

func TestJPEGOrientationMetadataBoundaries(t *testing.T) {
	valid := exifFixture("II", 1)
	mutate := func(offset int, value byte) []byte {
		data := bytes.Clone(valid)
		data[offset] = value
		return data
	}
	for _, tc := range []struct {
		name    string
		payload []byte
		want    bool
	}{
		{"XMP APP1", []byte("http://ns.adobe.com/xap/1.0/\x00<x:xmpmeta/>"), true},
		{"truncated EXIF", []byte("Exif\x00\x00"), false},
		{"bad byte order", mutate(6, 'X'), false},
		{"bad TIFF magic", mutate(8, 0), false},
		{"IFD inside header", mutate(10, 2), false},
		{"IFD beyond segment", mutate(13, 255), false},
		{"entries beyond segment", mutate(15, 255), false},
		{"wrong orientation type", mutate(18, 4), false},
		{"wrong orientation count", mutate(20, 2), false},
		{"truncated directory", valid[:len(valid)-1], false},
		{"zero orientation", mutate(24, 0), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			data := withJPEGAPP1([]byte{0xff, 0xd8, 0xff, 0xda}, tc.payload)
			if got := jpegKeepsOrientation(bytes.NewReader(data)); got != tc.want {
				t.Fatalf("keeps orientation = %v, want %v", got, tc.want)
			}
		})
	}
	// Check all metadata blocks, including an orientation after an XMP block.
	rotated := withJPEGAPP1([]byte{0xff, 0xd8, 0xff, 0xda}, exifFixture("MM", 6))
	if jpegKeepsOrientation(bytes.NewReader(withJPEGAPP1(rotated, []byte("XMP")))) {
		t.Fatal("a later EXIF segment was ignored")
	}
	if !jpegKeepsOrientation(bytes.NewReader([]byte{0xff, 0xd8, 0xff, 0xff, 0xda})) {
		t.Fatal("JPEG fill byte rejected")
	}
}

func withJPEGAPP1(jpeg []byte, payload []byte) []byte {
	result := append([]byte{0xff, 0xd8, 0xff, 0xe1, 0, 0}, payload...)
	binary.BigEndian.PutUint16(result[4:6], uint16(len(payload)+2))
	return append(result, jpeg[2:]...)
}

// An unrelated image-width entry remains when orientation is absent (zero).
func exifFixture(endian string, orientation uint16) []byte {
	var order binary.ByteOrder = binary.LittleEndian
	if endian == "MM" {
		order = binary.BigEndian
	}
	tiff := make([]byte, 26)
	copy(tiff, endian)
	order.PutUint16(tiff[2:], 42)
	order.PutUint32(tiff[4:], 8)
	order.PutUint16(tiff[8:], 1)
	order.PutUint16(tiff[10:], 0x0112)
	if orientation == 0 {
		order.PutUint16(tiff[10:], 0x0100)
	}
	order.PutUint16(tiff[12:], 3)
	order.PutUint32(tiff[14:], 1)
	order.PutUint16(tiff[18:], orientation)
	return append([]byte("Exif\x00\x00"), tiff...)
}
