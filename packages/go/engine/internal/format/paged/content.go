package paged

import (
	"bytes"
	"compress/flate"
	"io"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/keyword"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type Content struct {
	Head                HeadFields
	Tokens              []byte
	TokenOffsets        keyword.Uint32s
	DocumentFrequencies keyword.Uint32s
	PostingOffsets      keyword.Uint32s
	BlockLists          keyword.Uint32s
	BlockListOffsets    keyword.Uint32s
	BlockSummaries      []byte
	FieldLengths        []keyword.FieldLengthColumn
	Numeric             []keyword.ValueColumn
	Sizes               []keyword.ValueColumn
	Boolean             []keyword.BooleanColumn
	Enum                []keyword.EnumColumn
	Geopoint            []keyword.GeopointColumn
	Pattern             []keyword.PatternColumn
	PartialWords        *keyword.PartialWordColumn
	IDSample            []IDSampleEntry
	PostingDocuments    keyword.Uint32s
	PostingFrequencies  keyword.Uint16s
	PostingFields       keyword.Uint16s
	TokenTotals         keyword.Float64s
	TracksPositions     bool
	PositionOffsets     keyword.Uint32s
	Positions           keyword.Uint32s
	Documents           [][]byte
	IDs                 []byte
	IDOffsets           keyword.Uint32s
	IDOrder             keyword.Uint32s
	RemovalOffsets      keyword.Uint32s
	Removals            keyword.Uint32s
	SurfaceForms        *keyword.SurfaceFormColumn
	HasWriteRecords     bool
	SeqNos              keyword.Uint64s
	PrimaryTerms        keyword.Uint64s
}

func (content *Content) asSegment() *keyword.Segment {
	return &keyword.Segment{
		Schema: content.Head.Schema, Tombstones: content.Head.Tombstones, DocumentCount: content.Head.DocumentCount,
		IDs: content.IDs, IDOffsets: content.IDOffsets, IDOrder: content.IDOrder,
		Documents: []byte{}, DocumentOffsets: zeroOffsets(len(content.Documents)),
		FieldNames: content.Head.FieldNames, Tokens: content.Tokens, TokenOffsets: content.TokenOffsets,
		DocumentFrequencies: content.DocumentFrequencies, PostingOffsets: content.PostingOffsets,
		PostingDocuments: content.PostingDocuments, PostingFrequencies: content.PostingFrequencies,
		PostingFields: content.PostingFields, TracksPositions: content.TracksPositions,
		PositionOffsets: content.PositionOffsets, Positions: content.Positions,
		FieldLengths: content.FieldLengths, Numeric: content.Numeric, Sizes: content.Sizes, Boolean: content.Boolean,
		Enum: content.Enum, Geopoint: content.Geopoint, Pattern: content.Pattern, SurfaceForms: content.SurfaceForms,
		PartialWords: content.PartialWords, HasWriteRecords: content.HasWriteRecords, SeqNos: content.SeqNos,
		PrimaryTerms: content.PrimaryTerms,
	}
}

func zeroOffsets(count int) keyword.Uint32s {
	return make([]byte, (count+1)*keyword.Uint32Bytes)
}

func (content *Content) requireRules() error {
	if len(content.Documents) != int(content.Head.DocumentCount) {
		return saveFailed("The "+what+" holds a document list of another length than its document count", nil)
	}
	if err := content.asSegment().Validate(); err != nil {
		return narsilerr.Wrap(narsilerr.CodePersistenceSaveFailed,
			"The paged keyword segment breaks a rule of its format, so it cannot be written", err, nil)
	}
	return nil
}

func (content *Content) postingsSection() []byte {
	postings := make([]byte, 0, len(content.PostingDocuments)*2)
	for token := range content.PostingOffsets.Len() - 1 {
		from := int(content.PostingOffsets.At(token))
		to := int(content.PostingOffsets.At(token + 1))
		postings = append(postings, content.PostingDocuments[from*4:to*4]...)
		postings = append(postings, content.PostingFrequencies[from*2:to*2]...)
		postings = append(postings, content.PostingFields[from*2:to*2]...)
	}
	return postings
}

func DeflateBlock(raw []byte) ([]byte, error) {
	var compressed bytes.Buffer
	deflater, err := flate.NewWriter(&compressed, flate.DefaultCompression)
	if err != nil {
		return nil, err
	}
	if _, err := deflater.Write(raw); err != nil {
		return nil, err
	}
	if err := deflater.Close(); err != nil {
		return nil, err
	}
	return compressed.Bytes(), nil
}

func (content *Content) documentSections() ([]byte, []byte, error) {
	var compressed []byte
	writer := NewDocumentBlockWriter(func(deflated []byte) error {
		compressed = append(compressed, deflated...)
		return nil
	})
	for _, document := range content.Documents {
		if err := writer.Add(document); err != nil {
			return nil, nil, err
		}
	}
	blocks, err := writer.Finish()
	return compressed, blocks, err
}

func (content *Content) residentColumns() ResidentColumns {
	return ResidentColumns{Tokens: content.Tokens, TokenOffsets: content.TokenOffsets,
		DocumentFrequencies: content.DocumentFrequencies, PostingOffsets: content.PostingOffsets,
		BlockLists: content.BlockLists, BlockListOffsets: content.BlockListOffsets,
		BlockSummaries: content.BlockSummaries, FieldLengths: content.FieldLengths, Numeric: content.Numeric,
		Sizes: content.Sizes, Boolean: content.Boolean, Enum: content.Enum, Geopoint: content.Geopoint,
		Pattern: content.Pattern, PartialWords: content.PartialWords, IDSample: content.IDSample}
}

func (content *Content) Sources() ([]SectionSource, error) {
	if err := content.requireRules(); err != nil {
		return nil, err
	}
	documents, documentBlocks, err := content.documentSections()
	if err != nil {
		return nil, err
	}
	resident, err := ResidentSources(content.residentColumns(), documentBlocks)
	if err != nil {
		return nil, err
	}
	paged := []SectionSource{BytesSection("postings", content.postingsSection())}
	if content.TokenTotals != nil {
		paged = append(paged, BytesSection("tokenTotals", content.TokenTotals))
	}
	if content.TracksPositions {
		paged = append(paged, BytesSection("positionOffsets", content.PositionOffsets), BytesSection("positions", content.Positions))
	}
	paged = append(paged,
		BytesSection("documents", documents),
		BytesSection("ids", content.IDs),
		BytesSection("idOffsets", content.IDOffsets),
		BytesSection("idOrder", content.IDOrder),
		BytesSection("removalOffsets", content.RemovalOffsets),
		BytesSection("removals", content.Removals),
	)
	if content.HasWriteRecords {
		paged = append(paged, BytesSection("seqNos", content.SeqNos), BytesSection("primaryTerms", content.PrimaryTerms))
	}
	if content.SurfaceForms != nil {
		paged = append(paged, SurfaceFormSource(content.SurfaceForms))
	}
	return append(resident, paged...), nil
}

func WriteContent(writer io.Writer, content *Content) (keyword.Written, error) {
	sources, err := content.Sources()
	if err != nil {
		return keyword.Written{}, err
	}
	return WriteSegment(writer, content.Head, sources)
}
