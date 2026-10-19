package campaign

// ReferenceKind says how a record field holds the keys of other records.
type ReferenceKind string

const (
	// ReferenceOne is a single key string.
	ReferenceOne ReferenceKind = "one"
	// ReferenceMany is an array of key strings.
	ReferenceMany ReferenceKind = "many"
	// ReferenceObjects is an array of objects whose IDField holds the key.
	ReferenceObjects ReferenceKind = "objects"
)

// ReferenceField declares one field that points at records of another
// collection. The player projection, player-write checks and delete cascades
// all read this table, and a test keeps the browser editors in step with it.
type ReferenceField struct {
	Field   string        `json:"field"`
	Target  Collection    `json:"target"`
	Kind    ReferenceKind `json:"kind"`
	IDField string        `json:"idField,omitempty"`
	// Reserved values are always valid and never removed.
	Reserved []string `json:"reserved,omitempty"`
	// Placement names the map coordinates that belong to the referenced map.
	// They are hidden, kept and removed together with the reference.
	Placement []string `json:"placement,omitempty"`
	// Deleted replaces a ReferenceOne value whose target is deleted; Clears
	// lists fields reset to "" at the same time. Clears describe the target
	// (a faction rank), so they are also hidden and kept with the reference.
	Deleted string   `json:"deleted,omitempty"`
	Clears  []string `json:"clears,omitempty"`
}

// Dependents lists the fields that the player projection hides, and player
// saves keep, together with an unavailable ReferenceOne value.
func (reference ReferenceField) Dependents() []string {
	return append(append([]string(nil), reference.Placement...), reference.Clears...)
}

// Relationships (typed by settings) and companion owners (typed by ownerType)
// are polymorphic and handled where they are used, not in this table.
var referenceFields = map[Collection][]ReferenceField{
	Characters: {
		{Field: "faction", Target: Factions, Kind: ReferenceOne, Reserved: []string{"neutral", "party"},
			Deleted: "neutral", Clears: []string{"rank", "rankChain"}},
		{Field: "location", Target: Locations, Kind: ReferenceOne},
		{Field: "locationRoles", Target: Locations, Kind: ReferenceObjects, IDField: "locationId"},
	},
	Locations: {
		{Field: "parentId", Target: Locations, Kind: ReferenceOne, Placement: []string{"x", "y"}},
		{Field: "connections", Target: Locations, Kind: ReferenceMany},
		{Field: "characters", Target: Characters, Kind: ReferenceMany},
	},
	Events: {
		{Field: "characters", Target: Characters, Kind: ReferenceMany},
		{Field: "locations", Target: Locations, Kind: ReferenceMany},
		{Field: "consequence", Target: Events, Kind: ReferenceOne},
		{Field: "mapParentId", Target: Locations, Kind: ReferenceOne, Placement: []string{"mapX", "mapY"}},
	},
	Mysteries: {
		{Field: "characters", Target: Characters, Kind: ReferenceMany},
		{Field: "locations", Target: Locations, Kind: ReferenceMany},
	},
	HistoricalEvents: {
		{Field: "characters", Target: Characters, Kind: ReferenceMany},
		{Field: "locations", Target: Locations, Kind: ReferenceMany},
	},
	Artifacts: {
		{Field: "ownerCharacterId", Target: Characters, Kind: ReferenceOne},
		{Field: "locationId", Target: Locations, Kind: ReferenceOne},
	},
}

// dmOnlyFields never reach the player projection. Visibility-bearing records
// additionally hide linkedTwinId, which pairs a public and a DM-only twin.
var dmOnlyFields = map[Collection][]string{
	Locations: {"notes"},
}

// ReferenceFields returns the declared references held by a collection.
func ReferenceFields(collection Collection) []ReferenceField {
	return referenceFields[collection]
}

// DMOnlyFields returns the fields removed from a collection's player projection.
func DMOnlyFields(collection Collection) []string {
	descriptor, ok := Describe(collection)
	if !ok || !descriptor.VisibilityBearing {
		return nil
	}
	return append([]string{"linkedTwinId"}, dmOnlyFields[collection]...)
}
