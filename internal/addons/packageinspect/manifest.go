package packageinspect

type Manifest struct {
	PackageFormat    int               `json:"packageFormat"`
	ID               string            `json:"id"`
	Name             string            `json:"name"`
	Version          string            `json:"version"`
	Compatibility    Compatibility     `json:"compatibility"`
	Capabilities     Capabilities      `json:"capabilities"`
	Runtime          *Runtime          `json:"runtime,omitempty"`
	Permissions      []Permission      `json:"permissions"`
	Contributions    []Contribution    `json:"contributions,omitempty"`
	Collections      []Collection      `json:"collections,omitempty"`
	RecordExtensions []RecordExtension `json:"recordExtensions,omitempty"`
	Services         Services          `json:"services,omitempty"`
	Content          []ContentSet      `json:"content,omitempty"`
	Locales          map[string]string `json:"locales,omitempty"`
	Dependencies     []Dependency      `json:"dependencies,omitempty"`
}

type Capabilities struct {
	Required []string `json:"required"`
	Optional []string `json:"optional"`
}

type Compatibility struct {
	Host           string `json:"host"`
	AddonAPI       string `json:"addonApi"`
	WorkerProtocol string `json:"workerProtocol,omitempty"`
}

type Runtime struct {
	UI     *UIRuntime     `json:"ui,omitempty"`
	Worker *WorkerRuntime `json:"worker,omitempty"`
}

type UIRuntime struct {
	Mode    string   `json:"mode"`
	Entry   string   `json:"entry"`
	Styles  []string `json:"styles,omitempty"`
	Sandbox []string `json:"sandbox,omitempty"`
}

type WorkerRuntime struct {
	Type        string            `json:"type"`
	Protocol    string            `json:"protocol"`
	Entrypoint  string            `json:"entrypoint,omitempty"`
	Entrypoints map[string]string `json:"entrypoints,omitempty"`
}

type Permission struct {
	ID        string   `json:"id"`
	Resources []string `json:"resources"`
	Reason    string   `json:"reason"`
	Optional  bool     `json:"optional,omitempty"`
}

type Contribution struct {
	ID       string         `json:"id"`
	Surface  string         `json:"surface"`
	Label    string         `json:"label"`
	Roles    []string       `json:"roles,omitempty"`
	Order    int            `json:"order,omitempty"`
	Requires []string       `json:"requires,omitempty"`
	Config   map[string]any `json:"config,omitempty"`
}

type Collection struct {
	ID            string `json:"id"`
	Schema        string `json:"schema"`
	SchemaVersion string `json:"schemaVersion"`
}

type RecordExtension struct {
	ID            string `json:"id"`
	Target        string `json:"target"`
	Schema        string `json:"schema"`
	SchemaVersion string `json:"schemaVersion"`
}

type Services struct {
	Provides []ProvidedService `json:"provides,omitempty"`
	Consumes []ConsumedService `json:"consumes,omitempty"`
}

type ProvidedService struct {
	Contract  string `json:"contract"`
	Version   string `json:"version"`
	Transport string `json:"transport"`
	Schema    string `json:"schema"`
	Exclusive bool   `json:"exclusive,omitempty"`
}

type ConsumedService struct {
	Contract    string `json:"contract"`
	Range       string `json:"range"`
	Cardinality string `json:"cardinality"`
	Required    bool   `json:"required"`
	Selection   string `json:"selection"`
}

type ContentSet struct {
	ID       string `json:"id"`
	Root     string `json:"root"`
	Schema   string `json:"schema"`
	Revision string `json:"revision"`
}

type Dependency struct {
	ID       string `json:"id"`
	Range    string `json:"range"`
	Required bool   `json:"required"`
}
