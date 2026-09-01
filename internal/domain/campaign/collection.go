package campaign

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"unicode"
	"unicode/utf8"
)

const MaximumRecordBytes = 4 << 20

var (
	ErrInvalidCollection = errors.New("invalid campaign collection")
	ErrInvalidRecord     = errors.New("invalid campaign record")
)

type Collection string

const (
	Characters       Collection = "characters"
	Relationships    Collection = "relationships"
	Locations        Collection = "locations"
	Events           Collection = "events"
	Mysteries        Collection = "mysteries"
	Factions         Collection = "factions"
	DeletedDefaults  Collection = "deletedDefaults"
	Pantheon         Collection = "pantheon"
	Artifacts        Collection = "artifacts"
	Settings         Collection = "settings"
	HistoricalEvents Collection = "historicalEvents"
	Campaign         Collection = "campaign"
	Pets             Collection = "pets"
)

type Shape string

const (
	List  Shape = "list"
	Keyed Shape = "keyed"
)

type Visibility string

const (
	VisibilityPublic Visibility = "public"
	VisibilityDM     Visibility = "dm"
)

type Descriptor struct {
	Name              Collection
	Shape             Shape
	VisibilityBearing bool
	DMOnlyWrite       bool
}

var descriptors = []Descriptor{
	{Name: Characters, Shape: List, VisibilityBearing: true},
	{Name: Relationships, Shape: List, VisibilityBearing: true},
	{Name: Locations, Shape: List, VisibilityBearing: true},
	{Name: Events, Shape: List, VisibilityBearing: true},
	{Name: Mysteries, Shape: List, VisibilityBearing: true},
	{Name: Factions, Shape: Keyed, VisibilityBearing: true},
	{Name: DeletedDefaults, Shape: Keyed},
	{Name: Pantheon, Shape: List, VisibilityBearing: true},
	{Name: Artifacts, Shape: List, VisibilityBearing: true},
	{Name: Settings, Shape: Keyed, DMOnlyWrite: true},
	{Name: HistoricalEvents, Shape: List, VisibilityBearing: true},
	{Name: Campaign, Shape: Keyed, DMOnlyWrite: true},
	{Name: Pets, Shape: List},
}

func Descriptors() []Descriptor {
	result := make([]Descriptor, len(descriptors))
	copy(result, descriptors)
	return result
}

func Describe(collection Collection) (Descriptor, bool) {
	for _, descriptor := range descriptors {
		if descriptor.Name == collection {
			return descriptor, true
		}
	}
	return Descriptor{}, false
}

func ParseCollection(value string) (Collection, error) {
	collection := Collection(value)
	if _, ok := Describe(collection); !ok {
		return "", fmt.Errorf("%w: %q", ErrInvalidCollection, value)
	}
	return collection, nil
}

func ValidateKey(descriptor Descriptor, key string) error {
	if len(key) == 0 || len(key) > 1024 || !utf8.ValidString(key) {
		return fmt.Errorf("%w: record key must contain 1-1024 UTF-8 bytes", ErrInvalidRecord)
	}
	for _, character := range key {
		if unicode.IsControl(character) {
			return fmt.Errorf("%w: record key contains a control character", ErrInvalidRecord)
		}
	}
	if descriptor.Shape == Keyed &&
		(key == "__proto__" || key == "constructor" || key == "prototype") {
		return fmt.Errorf("%w: forbidden keyed record name", ErrInvalidRecord)
	}
	return nil
}

func NormalizeRecord(
	descriptor Descriptor,
	key string,
	value json.RawMessage,
) (json.RawMessage, Visibility, error) {
	if err := ValidateKey(descriptor, key); err != nil {
		return nil, "", err
	}
	trimmed := bytes.TrimSpace(value)
	if len(trimmed) == 0 || len(trimmed) > MaximumRecordBytes || !json.Valid(trimmed) {
		return nil, "", fmt.Errorf("%w: body must be bounded JSON", ErrInvalidRecord)
	}
	if descriptor.Shape == List {
		if trimmed[0] != '{' {
			return nil, "", fmt.Errorf("%w: list records must be JSON objects", ErrInvalidRecord)
		}
		derived, err := ListRecordKey(descriptor.Name, trimmed)
		if err != nil {
			return nil, "", err
		}
		if derived != key {
			return nil, "", fmt.Errorf("%w: record key does not match its JSON identity", ErrInvalidRecord)
		}
	}
	visibility, err := recordVisibility(descriptor, trimmed)
	if err != nil {
		return nil, "", err
	}
	buffer := &bytes.Buffer{}
	if err := json.Compact(buffer, trimmed); err != nil {
		return nil, "", fmt.Errorf("%w: compact body: %v", ErrInvalidRecord, err)
	}
	return json.RawMessage(buffer.Bytes()), visibility, nil
}

func ListRecordKey(collection Collection, value json.RawMessage) (string, error) {
	descriptor, ok := Describe(collection)
	if !ok || descriptor.Shape != List {
		return "", fmt.Errorf("%w: %q is not a list collection", ErrInvalidCollection, collection)
	}
	if collection == Relationships {
		var identity struct {
			Source string `json:"source"`
			Target string `json:"target"`
			Type   string `json:"type"`
		}
		if err := json.Unmarshal(value, &identity); err != nil ||
			!validIdentityPart(identity.Source, 200) ||
			!validIdentityPart(identity.Target, 200) ||
			!validIdentityPart(identity.Type, 200) {
			return "", fmt.Errorf(
				"%w: relationship requires bounded source, target, and type strings",
				ErrInvalidRecord,
			)
		}
		identityJSON, _ := json.Marshal([]string{identity.Source, identity.Target, identity.Type})
		return "relationship:" + base64.RawURLEncoding.EncodeToString(identityJSON), nil
	}
	var identity struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(value, &identity); err != nil || !validIdentityPart(identity.ID, 512) {
		return "", fmt.Errorf("%w: list record requires a bounded id string", ErrInvalidRecord)
	}
	return identity.ID, nil
}

func recordVisibility(descriptor Descriptor, value json.RawMessage) (Visibility, error) {
	if !descriptor.VisibilityBearing {
		return VisibilityPublic, nil
	}
	var envelope struct {
		Visibility string `json:"visibility"`
	}
	if err := json.Unmarshal(value, &envelope); err != nil {
		return "", fmt.Errorf("%w: read visibility: %v", ErrInvalidRecord, err)
	}
	switch envelope.Visibility {
	case "", string(VisibilityPublic):
		return VisibilityPublic, nil
	case string(VisibilityDM):
		return VisibilityDM, nil
	default:
		return "", fmt.Errorf("%w: visibility must be public or dm", ErrInvalidRecord)
	}
}

func validIdentityPart(value string, maximum int) bool {
	if len(value) == 0 || len(value) > maximum || !utf8.ValidString(value) {
		return false
	}
	for _, character := range value {
		if unicode.IsControl(character) {
			return false
		}
	}
	return true
}
