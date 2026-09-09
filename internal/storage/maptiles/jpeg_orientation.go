package maptiles

import (
	"bytes"
	"encoding/binary"
	"io"
)

func jpegKeepsOrientation(source io.ReadSeeker) bool {
	if _, err := source.Seek(2, io.SeekStart); err != nil {
		return false
	}
	for {
		var header [2]byte
		if _, err := io.ReadFull(source, header[:]); err != nil || header[0] != 0xff {
			return false
		}
		for header[1] == 0xff { // JPEG permits fill bytes before a marker.
			if _, err := io.ReadFull(source, header[1:]); err != nil {
				return false
			}
		}
		marker := header[1]
		if marker == 0xda || marker == 0xd9 {
			return true
		}
		if marker == 0 {
			return false
		}
		if marker == 0x01 || (marker >= 0xd0 && marker <= 0xd7) {
			continue // Standalone markers have no length field.
		}
		if _, err := io.ReadFull(source, header[:]); err != nil {
			return false
		}
		length := int(binary.BigEndian.Uint16(header[:])) - 2
		if length < 0 {
			return false
		}
		if marker == 0xe1 {
			// The JPEG segment length bounds this allocation to 64 KiB.
			payload := make([]byte, length)
			if _, err := io.ReadFull(source, payload); err != nil {
				return false
			}
			if bytes.HasPrefix(payload, []byte("Exif\x00\x00")) && !exifKeepsOrientation(payload[6:]) {
				return false
			}
		} else if _, err := source.Seek(int64(length), io.SeekCurrent); err != nil {
			return false
		}
	}
}

func exifKeepsOrientation(tiff []byte) bool {
	if len(tiff) < 8 {
		return false
	}
	var order binary.ByteOrder
	switch string(tiff[:2]) {
	case "II":
		order = binary.LittleEndian
	case "MM":
		order = binary.BigEndian
	default:
		return false
	}
	if order.Uint16(tiff[2:4]) != 42 {
		return false
	}
	offset := uint64(order.Uint32(tiff[4:8]))
	if offset < 8 || offset+2 > uint64(len(tiff)) {
		return false
	}
	count := uint64(order.Uint16(tiff[offset : offset+2]))
	if offset+2+count*12+4 > uint64(len(tiff)) {
		return false
	}
	// IFD0 describes the primary image. Thumbnail/sub-IFD orientation does not
	// affect its coordinates. Missing orientation and value 1 are untransformed.
	for i := uint64(0); i < count; i++ {
		entry := tiff[offset+2+i*12 : offset+2+(i+1)*12]
		if order.Uint16(entry[:2]) == 0x0112 &&
			(order.Uint16(entry[2:4]) != 3 || order.Uint32(entry[4:8]) != 1 || order.Uint16(entry[8:10]) != 1) {
			return false
		}
	}
	return true
}
