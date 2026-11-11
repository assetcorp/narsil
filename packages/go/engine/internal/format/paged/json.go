package paged

import (
	"bytes"
	"encoding/binary"
	"math"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/form"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/keyword"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

var numberSections = map[string]form.Width{
	"documentFrequencies": form.WidthUint32, "postingOffsets": form.WidthUint32, "blockLists": form.WidthUint32,
	"blockListOffsets": form.WidthUint32, "tokenTotals": form.WidthFloat64, "positionOffsets": form.WidthUint32,
	"positions": form.WidthUint32, "idOrder": form.WidthUint32, "removalOffsets": form.WidthUint32,
	"removals": form.WidthUint32, "seqNos": form.WidthUint64, "primaryTerms": form.WidthUint64,
}

var placementSections = map[string]struct{}{
	"documentBlocks": {}, "tokenOffsets": {}, "idOffsets": {}, "postings": {}, "documents": {}, "ids": {},
}

func (reader *Reader) columnValue(name string) (any, bool, error) {
	resident := &reader.Resident
	switch name {
	case "fieldLengths":
		return keyword.FieldLengthsValue(resident.FieldLengths), true, nil
	case "numeric":
		return keyword.ValueColumnsValue(resident.Numeric), true, nil
	case "sizes":
		return keyword.ValueColumnsValue(resident.Sizes), true, nil
	case "boolean":
		return keyword.BooleanColumnsValue(resident.Boolean), true, nil
	case "enum":
		return keyword.EnumColumnsValue(resident.Enum), true, nil
	case "geopoint":
		return keyword.GeopointColumnsValue(resident.Geopoint), true, nil
	case "pattern":
		return keyword.PatternColumnsValue(resident.Pattern), true, nil
	case "partialWords":
		return keyword.PartialWordsValue(resident.PartialWords), true, nil
	case "surfaceForms":
		column, err := reader.SurfaceForms()
		if err != nil {
			return nil, true, err
		}
		return keyword.SurfaceFormsValue(column), true, nil
	case "idSample":
		pairs := make([]any, len(resident.IDSample))
		for at, entry := range resident.IDSample {
			pairs[at] = []any{entry.ID, float64(entry.Position)}
		}
		return pairs, true, nil
	case "blockSummaries":
		summaries := make([]any, len(resident.BlockSummaries)/BlockSummaryBytes)
		for at := range summaries {
			summary := BlockSummaryAt(resident.BlockSummaries, at)
			summaries[at] = map[string]any{
				"postingEnd": float64(summary.PostingEnd), "maxTermFrequency": float64(summary.MaxTermFrequency),
				"minFieldLength": summary.MinFieldLength, "maxEntriesPerDocument": float64(summary.MaxEntriesPerDocument),
				"documentCount": float64(summary.DocumentCount),
			}
		}
		return summaries, true, nil
	}
	return nil, false, nil
}

func (reader *Reader) sectionValues() (map[string]any, error) {
	sections := map[string]any{}
	for _, section := range reader.Head.Sections {
		if _, placed := placementSections[section.Name]; placed {
			continue
		}
		value, known, err := reader.columnValue(section.Name)
		if err != nil {
			return nil, err
		}
		if known {
			sections[section.Name] = value
			continue
		}
		whole, err := reader.ReadSection(section, 0, section.Length)
		if err != nil {
			return nil, err
		}
		if width, isNumbers := numberSections[section.Name]; isNumbers {
			sections[section.Name] = form.Values(whole, width)
		} else {
			sections[section.Name] = whole
		}
	}
	return sections, nil
}

func (reader *Reader) listValues(sections map[string]any) error {
	var documents, frequencies, fields []float64
	for token := range reader.TokenCount() {
		list, err := reader.PostingList(token)
		if err != nil {
			return err
		}
		documents = append(documents, form.Values(list.Documents, form.WidthUint32)...)
		frequencies = append(frequencies, form.Values(list.Frequencies, form.WidthUint16)...)
		fields = append(fields, form.Values(list.Fields, form.WidthUint16)...)
	}
	sections["postingDocuments"] = documents
	sections["postingFrequencies"] = frequencies
	sections["postingFields"] = fields
	return nil
}

func FormOf(reader *Reader) (map[string]any, error) {
	sections, err := reader.sectionValues()
	if err != nil {
		return nil, err
	}
	sections["tokens"] = keyword.TextEntries(reader.Resident.Tokens, reader.Resident.TokenOffsets)
	count := reader.Head.DocumentCount
	ids := make([]any, 0, count)
	documents := make([]any, 0, count)
	for ordinal := range count {
		id, err := reader.IDBytes(ordinal)
		if err != nil {
			return nil, err
		}
		ids = append(ids, string(id))
		encoded, err := reader.EncodedDocument(ordinal)
		if err != nil {
			return nil, err
		}
		document, err := codec.Unmarshal(encoded, codec.DecodeOptions{ErrorCode: narsilerr.CodePersistenceLoadFailed})
		if err != nil {
			return nil, err
		}
		documents = append(documents, document)
	}
	sections["ids"] = ids
	sections["documents"] = documents
	if err := reader.listValues(sections); err != nil {
		return nil, err
	}
	head := reader.Head
	schema := make(map[string]any, len(head.Schema))
	for path, fieldType := range head.Schema {
		schema[path] = fieldType
	}
	return map[string]any{
		"header": form.HeaderOf(reader.Header).Value(),
		"head": map[string]any{
			"v": float64(HeadVersion), "schema": schema, "tombstones": form.StringValues(head.Tombstones),
			"documentCount": float64(head.DocumentCount), "fieldNames": form.StringValues(head.FieldNames),
		},
		"sections": sections,
	}, nil
}

func FormOfBytes(data []byte) (map[string]any, error) {
	reader, err := OpenBytes(data)
	if err != nil {
		return nil, err
	}
	return FormOf(reader)
}

func blockSummariesFromForm(sections *form.Fields) []byte {
	list := sections.List("blockSummaries")
	summaries := make([]byte, 0, len(list)*BlockSummaryBytes)
	for at := range list {
		entry := sections.Element(list, "blockSummaries", at)
		summaries = binary.LittleEndian.AppendUint32(summaries, uint32(entry.Uint("postingEnd", math.MaxUint32)))
		summaries = binary.LittleEndian.AppendUint16(summaries, uint16(entry.Uint("maxTermFrequency", math.MaxUint16)))
		summaries = binary.LittleEndian.AppendUint64(summaries, math.Float64bits(entry.Number("minFieldLength")))
		summaries = binary.LittleEndian.AppendUint32(summaries, uint32(entry.Uint("maxEntriesPerDocument", math.MaxUint32)))
		summaries = binary.LittleEndian.AppendUint32(summaries, uint32(entry.Uint("documentCount", math.MaxUint32)))
	}
	return summaries
}

func idSampleFromForm(sections *form.Fields) []IDSampleEntry {
	list := sections.List("idSample")
	sample := make([]IDSampleEntry, 0, len(list))
	for at, element := range list {
		pair, isList := element.([]any)
		if !isList || len(pair) != 2 {
			sections.Fail("idSample["+itoaInt(at)+"]", "is not an [id, position] pair")
			return nil
		}
		id, isText := pair[0].(string)
		if !isText {
			sections.Fail("idSample["+itoaInt(at)+"]", "is not an [id, position] pair")
			return nil
		}
		position := sections.UintAt(pair[1], "idSample["+itoaInt(at)+"]", math.MaxUint32)
		sample = append(sample, IDSampleEntry{ID: id, Position: uint32(position)})
	}
	return sample
}

func ContentFromForm(value map[string]any) (*Content, error) {
	root := form.NewFields(value, "", form.CodeJSONForm, "paged keyword segment JSON form")
	head := root.Object("head")
	sections := root.Object("sections")
	content := &Content{
		Head: HeadFields{
			Schema:        keyword.SchemaFromForm(head, "schema"),
			Tombstones:    head.Strings("tombstones"),
			DocumentCount: uint32(head.Uint("documentCount", math.MaxUint32)),
			FieldNames:    head.Strings("fieldNames"),
		},
		DocumentFrequencies: sections.NumberBytes("documentFrequencies", form.WidthUint32),
		PostingOffsets:      sections.NumberBytes("postingOffsets", form.WidthUint32),
		BlockLists:          sections.NumberBytes("blockLists", form.WidthUint32),
		BlockListOffsets:    sections.NumberBytes("blockListOffsets", form.WidthUint32),
		BlockSummaries:      blockSummariesFromForm(sections),
		FieldLengths:        keyword.FieldLengthsFromForm(sections, "fieldLengths"),
		Numeric:             keyword.ValueColumnsFromForm(sections, "numeric"),
		Sizes:               keyword.ValueColumnsFromForm(sections, "sizes"),
		Boolean:             keyword.BooleanColumnsFromForm(sections, "boolean"),
		Enum:                keyword.EnumColumnsFromForm(sections, "enum"),
		Geopoint:            keyword.GeopointColumnsFromForm(sections, "geopoint"),
		Pattern:             keyword.PatternColumnsFromForm(sections, "pattern"),
		PartialWords:        keyword.PartialWordsFromForm(sections, "partialWords"),
		IDSample:            idSampleFromForm(sections),
		PostingDocuments:    sections.NumberBytes("postingDocuments", form.WidthUint32),
		PostingFrequencies:  sections.NumberBytes("postingFrequencies", form.WidthUint16),
		PostingFields:       sections.NumberBytes("postingFields", form.WidthUint16),
		IDOrder:             sections.NumberBytes("idOrder", form.WidthUint32),
		RemovalOffsets:      sections.NumberBytes("removalOffsets", form.WidthUint32),
		Removals:            sections.NumberBytes("removals", form.WidthUint32),
		SurfaceForms:        keyword.SurfaceFormsFromForm(sections, "surfaceForms"),
	}
	content.Tokens, content.TokenOffsets = keyword.TextsFromForm(sections, "tokens")
	content.IDs, content.IDOffsets = keyword.TextsFromForm(sections, "ids")
	if sections.Has("tokenTotals") {
		content.TokenTotals = sections.NumberBytes("tokenTotals", form.WidthFloat64)
	}
	if sections.Has("positionOffsets") || sections.Has("positions") {
		content.TracksPositions = true
		content.PositionOffsets = sections.NumberBytes("positionOffsets", form.WidthUint32)
		content.Positions = sections.NumberBytes("positions", form.WidthUint32)
	}
	if sections.Has("seqNos") || sections.Has("primaryTerms") {
		content.HasWriteRecords = true
		content.SeqNos = sections.NumberBytes("seqNos", form.WidthUint64)
		content.PrimaryTerms = sections.NumberBytes("primaryTerms", form.WidthUint64)
	}
	for at, document := range sections.List("documents") {
		encoded, err := codec.Marshal(document, codec.EncodeOptions{ErrorCode: form.CodeJSONForm})
		if err != nil {
			sections.Fail("documents["+itoaInt(at)+"]", "fails to encode as MessagePack")
			break
		}
		content.Documents = append(content.Documents, encoded)
	}
	if err := root.Err(); err != nil {
		return nil, err
	}
	return content, nil
}

func PackForm(value map[string]any) ([]byte, error) {
	content, err := ContentFromForm(value)
	if err != nil {
		return nil, err
	}
	var output bytes.Buffer
	if _, err := WriteContent(&output, content); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}
