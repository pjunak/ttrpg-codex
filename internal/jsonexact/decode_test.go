package jsonexact

import (
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
