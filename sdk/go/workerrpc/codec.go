package workerrpc

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/pjunak/ttrpg-codex/contracts/addons/v3"
	"github.com/santhosh-tekuri/jsonschema/v6"
)

type Limits struct {
	MaxHeaderBytes int
	MaxFrameBytes  int
}

var DefaultLimits = Limits{
	MaxHeaderBytes: 8 << 10,
	MaxFrameBytes:  4 << 20,
}

type MessageKind string

const (
	KindRequest      MessageKind = "request"
	KindNotification MessageKind = "notification"
	KindSuccess      MessageKind = "success"
	KindFailure      MessageKind = "failure"
)

type Message struct {
	Kind  MessageKind
	Raw   json.RawMessage
	Value map[string]any
}

type Codec struct {
	reader *bufio.Reader
	writer io.Writer
	limits Limits
	schema *jsonschema.Schema
	write  sync.Mutex
}

func NewCodec(reader io.Reader, writer io.Writer, limits Limits) (*Codec, error) {
	if reader == nil {
		return nil, fmt.Errorf("worker protocol reader is required")
	}
	if writer == nil {
		return nil, fmt.Errorf("worker protocol writer is required")
	}
	limits = normalizedLimits(limits)

	document, err := jsonschema.UnmarshalJSON(bytes.NewReader(addonv3.ProtocolSchema()))
	if err != nil {
		return nil, fmt.Errorf("decode worker protocol schema: %w", err)
	}
	compiler := jsonschema.NewCompiler()
	compiler.DefaultDraft(jsonschema.Draft2020)
	compiler.AssertFormat()
	if err := compiler.AddResource("protocol.schema.json", document); err != nil {
		return nil, fmt.Errorf("load worker protocol schema: %w", err)
	}
	schema, err := compiler.Compile("protocol.schema.json")
	if err != nil {
		return nil, fmt.Errorf("compile worker protocol schema: %w", err)
	}

	return &Codec{
		reader: bufio.NewReaderSize(reader, min(limits.MaxHeaderBytes, 4<<10)),
		writer: writer,
		limits: limits,
		schema: schema,
	}, nil
}

func normalizedLimits(limits Limits) Limits {
	if limits.MaxHeaderBytes <= 0 {
		limits.MaxHeaderBytes = DefaultLimits.MaxHeaderBytes
	}
	if limits.MaxFrameBytes <= 0 {
		limits.MaxFrameBytes = DefaultLimits.MaxFrameBytes
	}
	return limits
}

func (c *Codec) Read(ctx context.Context) (Message, error) {
	if err := ctx.Err(); err != nil {
		return Message{}, err
	}
	length, err := c.readHeader(ctx)
	if err != nil {
		return Message{}, err
	}
	body := make([]byte, length)
	if _, err := io.ReadFull(&contextReader{ctx: ctx, reader: c.reader}, body); err != nil {
		return Message{}, protocolError(CodeTruncatedFrame, err)
	}
	return c.validate(body)
}

func (c *Codec) Write(ctx context.Context, value any) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	body, err := json.Marshal(value)
	if err != nil {
		return protocolError(CodeInvalidJSON, err)
	}
	if len(body) > c.limits.MaxFrameBytes {
		return protocolError(CodeFrameTooLarge, fmt.Errorf("%d bytes exceeds %d", len(body), c.limits.MaxFrameBytes))
	}
	if _, err := c.validate(body); err != nil {
		return err
	}
	header := []byte(fmt.Sprintf("Content-Length: %d\r\n\r\n", len(body)))

	c.write.Lock()
	defer c.write.Unlock()
	if err := writeAll(ctx, c.writer, header); err != nil {
		return fmt.Errorf("write worker frame header: %w", err)
	}
	if err := writeAll(ctx, c.writer, body); err != nil {
		return fmt.Errorf("write worker frame body: %w", err)
	}
	return nil
}

func (c *Codec) readHeader(ctx context.Context) (int, error) {
	header := make([]byte, 0, min(c.limits.MaxHeaderBytes, 256))
	for {
		if err := ctx.Err(); err != nil {
			return 0, err
		}
		character, err := c.reader.ReadByte()
		if err != nil {
			if errors.Is(err, io.EOF) && len(header) == 0 {
				return 0, io.EOF
			}
			return 0, protocolError(CodeMalformedHeader, fmt.Errorf("header ended before CRLF separator: %w", err))
		}
		header = append(header, character)
		if len(header) > c.limits.MaxHeaderBytes {
			return 0, protocolError(CodeHeaderTooLarge, fmt.Errorf("header exceeds %d bytes", c.limits.MaxHeaderBytes))
		}
		if character == '\n' && (len(header) < 2 || header[len(header)-2] != '\r') {
			return 0, protocolError(CodeMalformedHeader, errors.New("header lines must use CRLF"))
		}
		if len(header) >= 4 && bytes.Equal(header[len(header)-4:], []byte("\r\n\r\n")) {
			break
		}
	}
	return c.parseHeader(header[:len(header)-4])
}

func (c *Codec) parseHeader(body []byte) (int, error) {
	if len(body) == 0 {
		return 0, protocolError(CodeMissingContentLength, errors.New("Content-Length is required"))
	}
	seenLength := false
	contentLength := 0
	for _, line := range bytes.Split(body, []byte("\r\n")) {
		name, rawValue, ok := bytes.Cut(line, []byte(":"))
		if !ok || !validHeaderName(name) {
			return 0, protocolError(CodeMalformedHeader, fmt.Errorf("invalid header line %q", line))
		}
		if !strings.EqualFold(string(name), "Content-Length") {
			return 0, protocolError(CodeUnsupportedHeader, fmt.Errorf("header %q is unsupported", name))
		}
		if seenLength {
			return 0, protocolError(CodeDuplicateContentLength, errors.New("Content-Length appears more than once"))
		}
		seenLength = true
		value := strings.TrimSpace(string(rawValue))
		if value == "" || strings.IndexFunc(value, func(r rune) bool { return r < '0' || r > '9' }) >= 0 {
			return 0, protocolError(CodeInvalidContentLength, fmt.Errorf("invalid decimal length %q", value))
		}
		parsed, err := strconv.ParseUint(value, 10, 63)
		if err != nil || parsed == 0 {
			return 0, protocolError(CodeInvalidContentLength, fmt.Errorf("invalid decimal length %q", value))
		}
		if parsed > uint64(c.limits.MaxFrameBytes) {
			return 0, protocolError(CodeFrameTooLarge, fmt.Errorf("%d bytes exceeds %d", parsed, c.limits.MaxFrameBytes))
		}
		contentLength = int(parsed)
	}
	if !seenLength {
		return 0, protocolError(CodeMissingContentLength, errors.New("Content-Length is required"))
	}
	return contentLength, nil
}

func validHeaderName(name []byte) bool {
	if len(name) == 0 {
		return false
	}
	for _, character := range name {
		if !((character >= 'a' && character <= 'z') ||
			(character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') || character == '-') {
			return false
		}
	}
	return true
}

func (c *Codec) validate(body []byte) (Message, error) {
	if !utf8.Valid(body) {
		return Message{}, protocolError(CodeInvalidUTF8, errors.New("frame body is not valid UTF-8"))
	}
	instance, err := jsonschema.UnmarshalJSON(bytes.NewReader(body))
	if err != nil {
		return Message{}, protocolError(CodeInvalidJSON, err)
	}
	if err := c.schema.Validate(instance); err != nil {
		return Message{}, protocolError(CodeInvalidEnvelope, err)
	}
	value, ok := instance.(map[string]any)
	if !ok {
		return Message{}, protocolError(CodeInvalidEnvelope, errors.New("JSON-RPC batch messages are unsupported"))
	}
	return Message{
		Kind:  messageKind(value),
		Raw:   bytes.Clone(body),
		Value: value,
	}, nil
}

func messageKind(value map[string]any) MessageKind {
	if _, ok := value["method"]; ok {
		if _, ok := value["id"]; ok {
			return KindRequest
		}
		return KindNotification
	}
	if _, ok := value["error"]; ok {
		return KindFailure
	}
	return KindSuccess
}

func writeAll(ctx context.Context, writer io.Writer, body []byte) error {
	for len(body) > 0 {
		if err := ctx.Err(); err != nil {
			return err
		}
		written, err := writer.Write(body)
		if err != nil {
			return err
		}
		if written <= 0 {
			return io.ErrShortWrite
		}
		body = body[written:]
	}
	return nil
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r *contextReader) Read(buffer []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(buffer)
}
