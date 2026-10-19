// Package jsonexact decodes JSON that must match its Go type exactly.
package jsonexact

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
)

// ErrTrailing reports JSON that continues after its single value.
var ErrTrailing = errors.New("JSON contains more than one value")

// Decode reads exactly one JSON value into target, rejecting unknown object
// fields and anything after the value.
func Decode(body []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return ErrTrailing
	}
	return nil
}

// DecodeValue reads exactly one JSON value into target and keeps numbers as
// json.Number, so a value decoded into any and encoded again is not rounded
// through float64. Unknown object fields are allowed.
func DecodeValue(body []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return ErrTrailing
	}
	return nil
}
