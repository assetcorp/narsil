package paged

import (
	"encoding/binary"
	"math"
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/keyword"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type IDSampleEntry struct {
	ID       string
	Position uint32
}

type Resident struct {
	Tokens              []byte
	TokenOffsets        keyword.Uint32s
	DocumentFrequencies keyword.Uint32s
	PostingOffsets      keyword.Uint32s
	BlockLists          keyword.Uint32s
	BlockListOffsets    keyword.Uint32s
	BlockSummaries      []byte
	DocumentBlocks      []byte
	IDSample            []IDSampleEntry
	FieldLengths        []keyword.FieldLengthColumn
	Numeric             []keyword.ValueColumn
	Sizes               []keyword.ValueColumn
	Boolean             []keyword.BooleanColumn
	Enum                []keyword.EnumColumn
	Geopoint            []keyword.GeopointColumn
	Pattern             []keyword.PatternColumn
	PartialWords        *keyword.PartialWordColumn
	TracksPositions     bool
}

var requiredSections = []string{
	"tokens", "tokenOffsets", "documentFrequencies", "postingOffsets", "postings", "blockLists",
	"blockListOffsets", "blockSummaries", "documentBlocks", "documents", "idSample", "fieldLengths", "numeric",
	"sizes", "boolean", "enum", "geopoint", "pattern", "partialWords", "ids", "idOffsets", "idOrder",
	"removalOffsets", "removals",
}

func (reader *Reader) requireDocumentSectionLengths() error {
	documentCount := int64(reader.Head.DocumentCount)
	for _, rule := range []struct {
		name   string
		length int64
	}{
		{"idOffsets", (documentCount + 1) * keyword.Uint32Bytes},
		{"idOrder", documentCount * keyword.Uint32Bytes},
		{"removalOffsets", (documentCount + 1) * keyword.Uint32Bytes},
	} {
		section, _ := reader.Head.Section(rule.name)
		if section.Length != rule.length {
			return loadFailed("Section \""+rule.name+"\" of the "+what+" holds "+strconv.FormatInt(section.Length, 10)+
				" bytes where documentCount gives "+strconv.FormatInt(rule.length, 10),
				map[string]any{"section": rule.name, "documentCount": documentCount})
		}
	}
	return nil
}

func (reader *Reader) uint32Section(name string) (keyword.Uint32s, error) {
	bytes, err := reader.WholeSection(name)
	if err != nil {
		return nil, err
	}
	if len(bytes)%keyword.Uint32Bytes != 0 {
		return nil, loadFailed("Section \""+name+"\" of the "+what+" is not a whole number of values", nil)
	}
	return bytes, nil
}

func (reader *Reader) packedSection(name string) (any, error) {
	bytes, err := reader.WholeSection(name)
	if err != nil {
		return nil, err
	}
	value, err := codec.Unmarshal(bytes, codec.DecodeOptions{ErrorCode: narsilerr.CodePersistenceLoadFailed, ShareBinary: true})
	if err != nil {
		return nil, narsilerr.Wrap(narsilerr.CodePersistenceLoadFailed,
			"Section \""+name+"\" of the "+what+" is not MessagePack: "+err.Error(), err, nil)
	}
	return value, nil
}

func (reader *Reader) readResident() error {
	for _, name := range requiredSections {
		if _, err := reader.Section(name); err != nil {
			return err
		}
	}
	if err := reader.requireDocumentSectionLengths(); err != nil {
		return err
	}
	_, hasPositionOffsets := reader.Head.Section("positionOffsets")
	_, hasPositions := reader.Head.Section("positions")
	if hasPositionOffsets != hasPositions {
		return loadFailed("The "+what+" holds one of positionOffsets and positions", nil)
	}
	resident := &reader.Resident
	resident.TracksPositions = hasPositions
	var err error
	if resident.Tokens, err = reader.WholeSection("tokens"); err != nil {
		return err
	}
	for _, column := range []struct {
		name   string
		target *keyword.Uint32s
	}{
		{"tokenOffsets", &resident.TokenOffsets}, {"documentFrequencies", &resident.DocumentFrequencies},
		{"postingOffsets", &resident.PostingOffsets}, {"blockLists", &resident.BlockLists},
		{"blockListOffsets", &resident.BlockListOffsets},
	} {
		if *column.target, err = reader.uint32Section(column.name); err != nil {
			return err
		}
	}
	if resident.BlockSummaries, err = reader.WholeSection("blockSummaries"); err != nil {
		return err
	}
	if resident.DocumentBlocks, err = reader.WholeSection("documentBlocks"); err != nil {
		return err
	}
	if err := reader.checkTokenColumns(); err != nil {
		return err
	}
	if err := reader.checkBlockLayout(); err != nil {
		return err
	}
	if err := reader.checkDocumentBlockLayout(); err != nil {
		return err
	}
	if err := reader.readIDSample(); err != nil {
		return err
	}
	return reader.readColumns()
}

func (reader *Reader) checkTokenColumns() error {
	resident := &reader.Resident
	checker := keyword.NewChecker("Invalid paged keyword segment: ")
	checker.TokenColumns(resident.Tokens, resident.TokenOffsets)
	if checker.Failed() {
		return checker.Err()
	}
	tokenCount := resident.TokenOffsets.Len() - 1
	if resident.DocumentFrequencies.Len() != tokenCount || resident.PostingOffsets.Len() != tokenCount+1 {
		return loadFailed("The token columns of the "+what+" disagree on the token count", nil)
	}
	postings, _ := reader.Head.Section("postings")
	if postings.Length%PostingWidthBytes != 0 {
		return loadFailed("The postings section of the "+what+" is not a whole number of postings", nil)
	}
	checker.Offsets(resident.PostingOffsets, int(postings.Length/PostingWidthBytes), "postingOffsets")
	checker.DocumentFrequencies(resident.DocumentFrequencies, resident.PostingOffsets)
	return checker.Err()
}

func (reader *Reader) checkBlockLayout() error {
	resident := &reader.Resident
	if len(resident.BlockSummaries)%BlockSummaryBytes != 0 {
		return loadFailed("The block summaries of the "+what+" are cut short", nil)
	}
	lists := resident.BlockLists
	if resident.BlockListOffsets.Len() != lists.Len()+1 {
		return loadFailed("The block list offsets of the "+what+" have the wrong length", nil)
	}
	checker := keyword.NewChecker("Invalid paged keyword segment: ")
	checker.Offsets(resident.BlockListOffsets, len(resident.BlockSummaries)/BlockSummaryBytes, "blockListOffsets")
	if checker.Failed() {
		return checker.Err()
	}
	tokenCount := uint32(resident.TokenOffsets.Len() - 1)
	for at := range lists.Len() {
		token := lists.At(at)
		if at > 0 && token <= lists.At(at-1) {
			return loadFailed("blockLists of the "+what+" fails to ascend at entry "+itoaInt(at), map[string]any{"at": at})
		}
		if token >= tokenCount {
			return loadFailed("blockLists of the "+what+" holds a token past the token count", map[string]any{"at": at})
		}
		if resident.PostingOffsets.At(int(token)+1)-resident.PostingOffsets.At(int(token)) <= SmallestBlockPostings {
			return loadFailed("blockLists of the "+what+" lists a token that holds too few postings",
				map[string]any{"token": token})
		}
	}
	return nil
}

func documentBlockAt(blocks []byte, block int) (first uint32, offset uint64, length uint32, rawLength uint32) {
	place := blocks[block*DocumentBlockBytes:]
	return binary.LittleEndian.Uint32(place), binary.LittleEndian.Uint64(place[documentBlockOffsetAt:]),
		binary.LittleEndian.Uint32(place[documentBlockLengthAt:]), binary.LittleEndian.Uint32(place[documentBlockRawLengthAt:])
}

func (reader *Reader) checkDocumentBlockLayout() error {
	blocks := reader.Resident.DocumentBlocks
	if len(blocks)%DocumentBlockBytes != 0 {
		return loadFailed("The document blocks of the "+what+" are cut short", nil)
	}
	documents, _ := reader.Head.Section("documents")
	documentCount := reader.Head.DocumentCount
	count := len(blocks) / DocumentBlockBytes
	previousFirst := int64(-1)
	previousEnd := uint64(0)
	for block := range count {
		first, offset, length, _ := documentBlockAt(blocks, block)
		if int64(first) <= previousFirst || first >= documentCount {
			return loadFailed("Document block "+itoaInt(block)+" of the "+what+" starts wrongly", map[string]any{"block": block})
		}
		if offset != previousEnd || offset+uint64(length) > uint64(documents.Length) {
			return loadFailed("Document block "+itoaInt(block)+" of the "+what+" lies outside its section",
				map[string]any{"block": block})
		}
		previousFirst = int64(first)
		previousEnd = offset + uint64(length)
	}
	if documentCount > 0 && (count == 0 || binary.LittleEndian.Uint32(blocks) != 0) {
		return loadFailed("The document blocks of the "+what+" fail to cover its documents", nil)
	}
	return nil
}

func (reader *Reader) readIDSample() error {
	raw, err := reader.packedSection("idSample")
	if err != nil {
		return err
	}
	list, ok := raw.([]any)
	if !ok {
		return loadFailed("Section \"idSample\" of the "+what+" is not a list", nil)
	}
	sample := make([]IDSampleEntry, 0, len(list))
	for at, element := range list {
		pair, isList := element.([]any)
		if !isList || len(pair) < 2 {
			return loadFailed("Section \"idSample\" of the "+what+" holds an invalid entry at "+itoaInt(at), nil)
		}
		id, isText := pair[0].(string)
		position, isNumber := pair[1].(float64)
		if !isText || !isNumber || position < 0 || position > math.MaxUint32 || position != math.Trunc(position) {
			return loadFailed("Section \"idSample\" of the "+what+" holds an invalid entry at "+itoaInt(at), nil)
		}
		if at > 0 && uint32(position) <= sample[at-1].Position {
			return loadFailed("Section \"idSample\" of the "+what+" fails to ascend at entry "+itoaInt(at), nil)
		}
		sample = append(sample, IDSampleEntry{ID: id, Position: uint32(position)})
	}
	reader.Resident.IDSample = sample
	return nil
}

func (reader *Reader) readColumns() error {
	resident := &reader.Resident
	documentCount := reader.Head.DocumentCount
	checker := keyword.NewChecker("Invalid paged keyword segment: ")
	values := map[string]any{}
	for _, name := range []string{"fieldLengths", "numeric", "sizes", "boolean", "enum", "geopoint", "pattern", "partialWords"} {
		value, err := reader.packedSection(name)
		if err != nil {
			return err
		}
		values[name] = value
	}
	resident.FieldLengths = checker.ParseFieldLengths(values["fieldLengths"])
	checker.CheckFieldLengths(resident.FieldLengths, documentCount)
	resident.Numeric = checker.ParseValueColumns(values["numeric"], "numeric")
	checker.CheckValueColumns(resident.Numeric, "numeric", documentCount)
	resident.Sizes = checker.ParseValueColumns(values["sizes"], "sizes")
	checker.CheckValueColumns(resident.Sizes, "sizes", documentCount)
	resident.Boolean = checker.ParseBooleanColumns(values["boolean"])
	checker.CheckBooleanColumns(resident.Boolean, documentCount)
	resident.Enum = checker.ParseEnumColumns(values["enum"])
	checker.CheckEnumColumns(resident.Enum, documentCount)
	resident.Geopoint = checker.ParseGeopointColumns(values["geopoint"])
	checker.CheckGeopointColumns(resident.Geopoint, documentCount)
	resident.Pattern = checker.ParsePatternColumns(values["pattern"])
	checker.CheckPatternColumns(resident.Pattern, documentCount)
	resident.PartialWords = checker.ParsePartialWords(values["partialWords"])
	checker.CheckPartialWords(resident.PartialWords, resident.TokenOffsets.Len()-1)
	return checker.Err()
}
