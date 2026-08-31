// Package addonv3 embeds the reviewed source schemas used by the Go host.
package addonv3

import (
	"bytes"
	"embed"
)

//go:embed manifest.schema.json protocol.schema.json checksums.schema.json service-document.schema.json
var schemas embed.FS

func ManifestSchema() []byte {
	return schema("manifest.schema.json")
}

func ProtocolSchema() []byte {
	return schema("protocol.schema.json")
}

func ChecksumsSchema() []byte {
	return schema("checksums.schema.json")
}

func ServiceDocumentSchema() []byte {
	return schema("service-document.schema.json")
}

func schema(name string) []byte {
	value, err := schemas.ReadFile(name)
	if err != nil {
		panic(err)
	}
	return bytes.Clone(value)
}
