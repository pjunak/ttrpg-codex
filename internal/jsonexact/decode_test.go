package jsonexact

import (
	"encoding/json"
	"errors"
	"testing"
)

func TestDecode(t *testing.T) {
	var value struct {
		Name string `json:"name"`
	}
	if err := Decode([]byte(` {"name":"Ryn"} `), &value); err != nil || value.Name != "Ryn" {
		t.Fatalf("Decode = %v, %+v", err, value)
	}
	if err := Decode([]byte(`{"name":"Ryn","extra":1}`), &value); err == nil {
		t.Fatal("unknown field accepted")
	}
	if err := Decode([]byte(`{"name":"Ryn"} {}`), &value); !errors.Is(err, ErrTrailing) {
		t.Fatalf("trailing value: %v", err)
	}
	if err := Decode([]byte(`{"name":"Ryn"} x`), &value); !errors.Is(err, ErrTrailing) {
		t.Fatalf("trailing text: %v", err)
	}
}

func TestDecodeValueKeepsNumbersExact(t *testing.T) {
	const body = `{"seed":1234567890123456789,"ratio":0.1000000000000000055511151231257827,"extra":[1e400]}`
	var value map[string]any
	if err := DecodeValue([]byte(body), &value); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(value)
	if err != nil || string(encoded) != `{"extra":[1e400],"ratio":0.1000000000000000055511151231257827,"seed":1234567890123456789}` {
		t.Fatalf("round trip = %s, %v", encoded, err)
	}
	if err := DecodeValue([]byte(`{} {}`), &value); !errors.Is(err, ErrTrailing) {
		t.Fatalf("trailing value: %v", err)
	}
}
