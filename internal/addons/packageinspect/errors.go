package packageinspect

import "fmt"

const (
	CodeArchiveTooLarge    = "ARCHIVE_TOO_LARGE"
	CodeExpandedTooLarge   = "EXPANDED_TOO_LARGE"
	CodeTooManyFiles       = "TOO_MANY_FILES"
	CodeUnsafePath         = "UNSAFE_PATH"
	CodeDuplicatePath      = "DUPLICATE_PATH"
	CodeUnsupportedEntry   = "UNSUPPORTED_ENTRY"
	CodeMissingFile        = "MISSING_FILE"
	CodeInvalidManifest    = "INVALID_MANIFEST"
	CodeInvalidChecksums   = "INVALID_CHECKSUMS"
	CodeChecksumMismatch   = "CHECKSUM_MISMATCH"
	CodeInvalidDeclaration = "INVALID_DECLARATION"
	CodeInvalidSchema      = "INVALID_SCHEMA"
	CodeInvalidContent     = "INVALID_CONTENT"
	CodeExtractionFailed   = "EXTRACTION_FAILED"
)

type InspectionError struct {
	Code  string
	Path  string
	Cause error
}

func (e *InspectionError) Error() string {
	if e.Path == "" {
		return fmt.Sprintf("%s: %v", e.Code, e.Cause)
	}
	return fmt.Sprintf("%s at %s: %v", e.Code, e.Path, e.Cause)
}

func (e *InspectionError) Unwrap() error {
	return e.Cause
}

func inspectionError(code, path string, cause error) error {
	return &InspectionError{Code: code, Path: path, Cause: cause}
}
