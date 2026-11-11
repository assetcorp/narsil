package export

import (
	"io"
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/form"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

const (
	formHeaderKey    = "header"
	formDocumentsKey = "documents"
)

type Form struct {
	Header    map[string]any
	Documents []map[string]any
}

func ReadForm(source io.Reader) (Form, error) {
	reader, header, err := NewReader(source)
	if err != nil {
		return Form{}, err
	}
	parsed := Form{Header: map[string]any{
		headerFormatKey:  FormatName,
		headerVersionKey: float64(FormatVersion),
		headerIndexKey:   header.Index,
	}}
	for {
		entry, found, err := reader.Next()
		if err != nil {
			return Form{}, err
		}
		if !found {
			return parsed, nil
		}
		if entry.Refused != nil {
			return Form{}, entry.Refused
		}
		line, err := codec.AppendDocumentJSON(nil, entry.Document, entry.ID)
		if err != nil {
			return Form{}, err
		}
		tagged, err := codec.ParseJSON(line, narsilerr.CodeDocValidationFailed)
		if err != nil {
			return Form{}, err
		}
		document, isRecord := tagged.(map[string]any)
		if !isRecord {
			return Form{}, narsilerr.New(narsilerr.CodeDocValidationFailed, "The document line is not an object", nil)
		}
		parsed.Documents = append(parsed.Documents, document)
	}
}

func (parsed Form) Value() map[string]any {
	documents := make([]any, len(parsed.Documents))
	for index, document := range parsed.Documents {
		documents[index] = document
	}
	return map[string]any{formHeaderKey: parsed.Header, formDocumentsKey: documents}
}

func (parsed Form) Encode() ([]byte, error) {
	return codec.AppendExactJSON(nil, parsed.Value(), "")
}

func DecodeForm(data []byte) (Form, error) {
	value, err := codec.ParseJSON(data, form.CodeJSONForm)
	if err != nil {
		return Form{}, err
	}
	fields := form.NewFields(value, "", form.CodeJSONForm, "document export JSON form")
	header := fields.Object(formHeaderKey).Map()
	list := fields.List(formDocumentsKey)
	parsed := Form{Header: header, Documents: make([]map[string]any, 0, len(list))}
	for index := range list {
		parsed.Documents = append(parsed.Documents, fields.Element(list, formDocumentsKey, index).Map())
	}
	if err := fields.Err(); err != nil {
		return Form{}, err
	}
	return parsed, nil
}

func WriteForm(destination io.Writer, parsed Form) error {
	headerLine, err := codec.AppendExactJSON(nil, parsed.Header, "")
	if err != nil {
		return err
	}
	header, err := ParseHeader(headerLine)
	if err != nil {
		return err
	}
	writer, err := NewWriter(destination, header)
	if err != nil {
		return err
	}
	for index, raw := range parsed.Documents {
		line, err := codec.AppendExactJSON(nil, raw, "")
		if err != nil {
			return err
		}
		id, document, err := DecodeDocumentLine(line)
		if err != nil {
			return narsilerr.Wrap(form.CodeJSONForm, "Document "+strconv.Itoa(index)+" of the JSON form cannot be written", err, nil)
		}
		if err := writer.WriteDocument(id, document); err != nil {
			return err
		}
	}
	return nil
}
