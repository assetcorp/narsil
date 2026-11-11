package keyword

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/form"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

func TextEntries(blob []byte, offsets Uint32s) []any {
	count := offsets.Len() - 1
	entries := make([]any, 0, max(count, 0))
	for at := range max(count, 0) {
		entries = append(entries, string(entryOf(blob, offsets, at)))
	}
	return entries
}

func PackedEntries(blob []byte, offsets Uint32s) ([]any, error) {
	count := max(offsets.Len()-1, 0)
	entries := make([]any, 0, count)
	for at := range count {
		value, err := codec.Unmarshal(entryOf(blob, offsets, at), codec.DecodeOptions{
			ErrorCode: narsilerr.CodePersistenceLoadFailed,
		})
		if err != nil {
			return nil, err
		}
		entries = append(entries, value)
	}
	return entries, nil
}

func numbers(data []byte, width form.Width) []float64 {
	return form.Values(data, width)
}

func numbersOrNil(data []byte, width form.Width, present bool) any {
	if !present {
		return nil
	}
	return numbers(data, width)
}

func schemaValue(schema map[string]string) map[string]any {
	value := make(map[string]any, len(schema))
	for path, fieldType := range schema {
		value[path] = fieldType
	}
	return value
}

func FormOf(file File) (map[string]any, error) {
	payload, err := file.Segment.FormPayload()
	if err != nil {
		return nil, err
	}
	return map[string]any{"header": form.HeaderOf(file.Header).Value(), "payload": payload}, nil
}

func (segment *Segment) FormPayload() (map[string]any, error) {
	documents, err := PackedEntries(segment.Documents, segment.DocumentOffsets)
	if err != nil {
		return nil, err
	}
	payload := map[string]any{
		"v":                   float64(PayloadVersion),
		"schema":              schemaValue(segment.Schema),
		"tombstones":          form.StringValues(segment.Tombstones),
		"documentCount":       float64(segment.DocumentCount),
		"ids":                 TextEntries(segment.IDs, segment.IDOffsets),
		"idOrder":             numbers(segment.IDOrder, form.WidthUint32),
		"documents":           documents,
		"fieldNames":          form.StringValues(segment.FieldNames),
		"tokens":              TextEntries(segment.Tokens, segment.TokenOffsets),
		"documentFrequencies": numbers(segment.DocumentFrequencies, form.WidthUint32),
		"postingOffsets":      numbers(segment.PostingOffsets, form.WidthUint32),
		"postingDocuments":    numbers(segment.PostingDocuments, form.WidthUint32),
		"postingFrequencies":  numbers(segment.PostingFrequencies, form.WidthUint16),
		"postingFields":       numbers(segment.PostingFields, form.WidthUint16),
		"positionOffsets":     numbersOrNil(segment.PositionOffsets, form.WidthUint32, segment.TracksPositions),
		"positions":           numbersOrNil(segment.Positions, form.WidthUint32, segment.TracksPositions),
	}
	for key, value := range ColumnValues(segment) {
		payload[key] = value
	}
	if segment.HasWriteRecords {
		payload["seqNos"] = numbers(segment.SeqNos, form.WidthUint64)
		payload["primaryTerms"] = numbers(segment.PrimaryTerms, form.WidthUint64)
	}
	return payload, nil
}

func FromForm(value map[string]any) (form.HeaderForm, *Segment, error) {
	root := form.NewFields(value, "", form.CodeJSONForm, "keyword segment JSON form")
	header := form.HeaderFrom(root.Object("header"))
	payload := root.Object("payload")
	if err := root.Err(); err != nil {
		return form.HeaderForm{}, nil, err
	}
	segment, err := SegmentFromForm(payload)
	return header, segment, err
}

func SegmentFromForm(payload *form.Fields) (*Segment, error) {
	segment := &Segment{
		Schema:              SchemaFromForm(payload, "schema"),
		Tombstones:          payload.Strings("tombstones"),
		DocumentCount:       uint32(payload.Uint("documentCount", MaxDocumentCountValue)),
		IDOrder:             payload.NumberBytes("idOrder", form.WidthUint32),
		FieldNames:          payload.Strings("fieldNames"),
		DocumentFrequencies: payload.NumberBytes("documentFrequencies", form.WidthUint32),
		PostingOffsets:      payload.NumberBytes("postingOffsets", form.WidthUint32),
		PostingDocuments:    payload.NumberBytes("postingDocuments", form.WidthUint32),
		PostingFrequencies:  payload.NumberBytes("postingFrequencies", form.WidthUint16),
		PostingFields:       payload.NumberBytes("postingFields", form.WidthUint16),
	}
	segment.IDs, segment.IDOffsets = TextsFromForm(payload, "ids")
	segment.Tokens, segment.TokenOffsets = TextsFromForm(payload, "tokens")
	segment.Documents, segment.DocumentOffsets = PackedFromForm(payload, "documents")
	if payload.HasValue("positionOffsets") || payload.HasValue("positions") {
		segment.TracksPositions = true
		segment.PositionOffsets = payload.NumberBytes("positionOffsets", form.WidthUint32)
		segment.Positions = payload.NumberBytes("positions", form.WidthUint32)
	}
	ColumnsFromForm(payload, segment)
	if payload.Has("seqNos") || payload.Has("primaryTerms") {
		segment.HasWriteRecords = true
		segment.SeqNos = payload.NumberBytes("seqNos", form.WidthUint64)
		segment.PrimaryTerms = payload.NumberBytes("primaryTerms", form.WidthUint64)
	}
	if err := payload.Err(); err != nil {
		return nil, err
	}
	return segment, nil
}

func SchemaFromForm(fields *form.Fields, key string) map[string]string {
	record := fields.Object(key)
	schema := make(map[string]string, len(record.Map()))
	for _, path := range record.Keys() {
		schema[path] = record.String(path)
	}
	return schema
}

func joinEntries(entries [][]byte) ([]byte, Uint32s) {
	total := 0
	for _, entry := range entries {
		total += len(entry)
	}
	blob := make([]byte, 0, total)
	offsets := make([]byte, 0, (len(entries)+1)*Uint32Bytes)
	offsets = append(offsets, 0, 0, 0, 0)
	for _, entry := range entries {
		blob = append(blob, entry...)
		offsets = append(offsets, Uint32sOf(uint32(len(blob)))...)
	}
	return blob, offsets
}

func TextsFromForm(fields *form.Fields, key string) ([]byte, Uint32s) {
	texts := fields.Strings(key)
	entries := make([][]byte, len(texts))
	for at, text := range texts {
		entries[at] = []byte(text)
	}
	return joinEntries(entries)
}

func PackedFromForm(fields *form.Fields, key string) ([]byte, Uint32s) {
	list := fields.List(key)
	entries := make([][]byte, 0, len(list))
	for at, element := range list {
		encoded, err := codec.Marshal(element, codec.EncodeOptions{})
		if err != nil {
			fields.Fail(key+"["+itoa(at)+"]", "fails to encode as MessagePack")
			return nil, nil
		}
		entries = append(entries, encoded)
	}
	return joinEntries(entries)
}
