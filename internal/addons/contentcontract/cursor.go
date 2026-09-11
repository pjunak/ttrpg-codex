package contentcontract

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
)

// Cursors bind the stable position to the exact effective set and query. A
// changed source policy cannot resume a page in a different content snapshot.
func EncodeCursor(position int, setID, revision, kind string) string {
	digest := sha256.Sum256([]byte(setID + "\x00" + revision + "\x00" + kind))
	body := make([]byte, 20)
	copy(body, digest[:16])
	binary.BigEndian.PutUint32(body[16:], uint32(position))
	return base64.RawURLEncoding.EncodeToString(body)
}

func DecodeCursor(value, setID, revision, kind string) (int, error) {
	if value == "" {
		return -1, nil
	}
	if len(value) > 32 {
		return 0, ErrInvalidQuery
	}
	body, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(body) != 20 {
		return 0, ErrInvalidQuery
	}
	digest := sha256.Sum256([]byte(setID + "\x00" + revision + "\x00" + kind))
	position := int(binary.BigEndian.Uint32(body[16:]))
	if !bytes.Equal(body[:16], digest[:16]) || position >= MaximumRecords || value != EncodeCursor(position, setID, revision, kind) {
		return 0, ErrInvalidQuery
	}
	return position, nil
}
