package export

import (
	"io"
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

const (
	FormatName    = "narsil-export"
	FormatVersion = 1

	headerFormatKey  = "format"
	headerVersionKey = "version"
	headerIndexKey   = "index"
	documentIDKey    = "id"
)

type Header struct {
	Index       map[string]any
	SchemaOrder []string
}

type Entry struct {
	Line     int
	ID       string
	Document map[string]any
	Refused  error
}

type Reader struct {
	lines *LineReader
}

func invalidHeader(message string) error {
	return narsilerr.New(narsilerr.CodeConfigInvalid, "The document export header "+message, nil)
}

func ParseHeader(text []byte) (Header, error) {
	parsed, err := codec.ParseJSON(text, narsilerr.CodeConfigInvalid)
	if err != nil {
		reason := "is not JSON"
		if typed, ok := narsilerr.As(err); ok {
			reason = "cannot be read: " + typed.Message
		}
		return Header{}, narsilerr.Wrap(narsilerr.CodeConfigInvalid, "The document export header "+reason, err, nil)
	}
	record, isRecord := parsed.(map[string]any)
	if !isRecord || record[headerFormatKey] != FormatName || record[headerVersionKey] != float64(FormatVersion) {
		return Header{}, invalidHeader("must name format \"" + FormatName + "\" and version " + strconv.Itoa(FormatVersion))
	}
	index, isIndex := record[headerIndexKey].(map[string]any)
	if !isIndex {
		return Header{}, invalidHeader("holds no index configuration object under \"index\"")
	}
	return Header{Index: index, SchemaOrder: headerSchemaOrder(text)}, nil
}

func NewReader(source io.Reader) (*Reader, Header, error) {
	lines := NewLineReader(source, MaxLineBytes)
	first, found, err := lines.Next()
	if err != nil {
		return nil, Header{}, err
	}
	if !found {
		return nil, Header{}, invalidHeader("is missing")
	}
	if first.TooLong {
		return nil, Header{}, invalidHeader("passes the line limit of " + strconv.Itoa(MaxLineBytes) + " bytes")
	}
	header, err := ParseHeader(first.Text)
	if err != nil {
		return nil, Header{}, err
	}
	return &Reader{lines: lines}, header, nil
}

func refusal(line int, message string, cause error) error {
	code := narsilerr.CodeDocValidationFailed
	if cause != nil {
		if typed, ok := narsilerr.As(cause); ok {
			code = typed.Code
			message = typed.Message
		}
	}
	return narsilerr.New(code, message, map[string]any{"line": line})
}

func DecodeDocumentLine(text []byte) (string, map[string]any, error) {
	parsed, err := codec.ParseJSON(text, narsilerr.CodeDocValidationFailed)
	if err != nil {
		return "", nil, err
	}
	document, isRecord := parsed.(map[string]any)
	id, isText := document[documentIDKey].(string)
	if !isRecord || !isText || id == "" {
		return "", nil, narsilerr.New(narsilerr.CodeDocValidationFailed, "The line holds no document with a string id", nil)
	}
	untagged, err := codec.UntagDocumentLine(string(text), document)
	if err != nil {
		return "", nil, err
	}
	if err := schema.ValidateDocID(id); err != nil {
		return "", nil, err
	}
	return id, untagged, nil
}

func (reader *Reader) Next() (Entry, bool, error) {
	for {
		line, found, err := reader.lines.Next()
		if err != nil || !found {
			return Entry{}, false, err
		}
		if line.TooLong {
			return Entry{Line: line.Number, Refused: refusal(line.Number,
				"The line passes the limit of "+strconv.Itoa(MaxLineBytes)+" bytes", nil)}, true, nil
		}
		if len(line.Text) == 0 {
			continue
		}
		id, document, err := DecodeDocumentLine(line.Text)
		if err != nil {
			return Entry{Line: line.Number, Refused: refusal(line.Number, err.Error(), err)}, true, nil
		}
		return Entry{Line: line.Number, ID: id, Document: document}, true, nil
	}
}
