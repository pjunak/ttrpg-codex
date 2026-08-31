// Package workerrpc implements the shared Add-on API v3 worker transport.
package workerrpc

import "fmt"

const (
	CodeHeaderTooLarge         = "HEADER_TOO_LARGE"
	CodeMalformedHeader        = "MALFORMED_HEADER"
	CodeUnsupportedHeader      = "UNSUPPORTED_HEADER"
	CodeMissingContentLength   = "MISSING_CONTENT_LENGTH"
	CodeDuplicateContentLength = "DUPLICATE_CONTENT_LENGTH"
	CodeInvalidContentLength   = "INVALID_CONTENT_LENGTH"
	CodeFrameTooLarge          = "FRAME_TOO_LARGE"
	CodeTruncatedFrame         = "TRUNCATED_FRAME"
	CodeInvalidUTF8            = "INVALID_UTF8"
	CodeInvalidJSON            = "INVALID_JSON"
	CodeInvalidEnvelope        = "INVALID_ENVELOPE"
)

type ProtocolError struct {
	Code  string
	Cause error
}

func (e *ProtocolError) Error() string {
	return fmt.Sprintf("%s: %v", e.Code, e.Cause)
}

func (e *ProtocolError) Unwrap() error {
	return e.Cause
}

func protocolError(code string, cause error) error {
	return &ProtocolError{Code: code, Cause: cause}
}
