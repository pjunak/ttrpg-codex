package workerrpc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
)

const (
	JSONRPCInvalidRequest = -32600
	JSONRPCMethodNotFound = -32601
	JSONRPCInvalidParams  = -32602
	JSONRPCInternalError  = -32603
	JSONRPCApplication    = -32000
)

const (
	KindInvalidRequest   = "INVALID_REQUEST"
	KindUnauthorized     = "UNAUTHORIZED"
	KindNotFound         = "NOT_FOUND"
	KindConflict         = "CONFLICT"
	KindStaleBinding     = "STALE_BINDING"
	KindValidationFailed = "VALIDATION_FAILED"
	KindRateLimited      = "RATE_LIMITED"
	KindUnavailable      = "UNAVAILABLE"
	KindDeadlineExceeded = "DEADLINE_EXCEEDED"
	KindCancelled        = "CANCELLED"
	KindInternal         = "INTERNAL"
)

var knownErrorKinds = map[string]struct{}{
	KindInvalidRequest:   {},
	KindUnauthorized:     {},
	KindNotFound:         {},
	KindConflict:         {},
	KindStaleBinding:     {},
	KindValidationFailed: {},
	KindRateLimited:      {},
	KindUnavailable:      {},
	KindDeadlineExceeded: {},
	KindCancelled:        {},
	KindInternal:         {},
}

type ErrorData struct {
	Kind      string          `json:"kind"`
	Message   string          `json:"message"`
	Retryable bool            `json:"retryable"`
	Details   json.RawMessage `json:"details,omitempty"`
}

type RPCError struct {
	Code         int        `json:"code"`
	Message      string     `json:"message"`
	Data         *ErrorData `json:"data,omitempty"`
	ReportedKind string     `json:"-"`
	cause        error
}

func (e *RPCError) Error() string {
	if e.Data != nil {
		return fmt.Sprintf("worker RPC %d %s: %s", e.Code, e.Data.Kind, e.Data.Message)
	}
	return fmt.Sprintf("worker RPC %d: %s", e.Code, e.Message)
}

func (e *RPCError) Unwrap() error {
	return e.cause
}

func NewRPCError(code int, kind string, message string, retryable bool, details any) *RPCError {
	if _, known := knownErrorKinds[kind]; !known {
		kind = KindInternal
	}
	data := &ErrorData{
		Kind:      kind,
		Message:   message,
		Retryable: retryable,
	}
	if details != nil {
		if body, err := json.Marshal(details); err == nil && string(body) != "null" {
			data.Details = body
		}
	}
	return &RPCError{Code: code, Message: message, Data: data}
}

func ErrorFromContext(err error) *RPCError {
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		failure := NewRPCError(JSONRPCApplication, KindDeadlineExceeded, "The request deadline was exceeded.", true, nil)
		failure.cause = err
		return failure
	case errors.Is(err, context.Canceled):
		failure := NewRPCError(JSONRPCApplication, KindCancelled, "The request was cancelled.", false, nil)
		failure.cause = err
		return failure
	default:
		failure := NewRPCError(JSONRPCInternalError, KindInternal, "The worker RPC operation failed.", false, nil)
		failure.cause = err
		return failure
	}
}

func normalizeRemoteError(failure *RPCError) *RPCError {
	if failure == nil {
		return failure
	}
	if failure.Data == nil {
		failure.Data = &ErrorData{
			Kind:      KindInternal,
			Message:   failure.Message,
			Retryable: false,
		}
		return failure
	}
	if _, known := knownErrorKinds[failure.Data.Kind]; known {
		return failure
	}
	failure.ReportedKind = failure.Data.Kind
	failure.Data.Kind = KindInternal
	return failure
}
