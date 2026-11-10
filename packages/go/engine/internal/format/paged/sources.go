package paged

import (
	"encoding/binary"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/keyword"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type ResidentColumns struct {
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
}

func encodeColumns(write func(chunks *keyword.Chunks)) []byte {
	chunks := &keyword.Chunks{}
	write(chunks)
	return chunks.Joined()
}

func idSampleSection(sample []IDSampleEntry) ([]byte, error) {
	list := make([]any, len(sample))
	for at, entry := range sample {
		list[at] = []any{entry.ID, float64(entry.Position)}
	}
	return codec.Marshal(list, codec.EncodeOptions{ErrorCode: narsilerr.CodePersistenceSaveFailed})
}

func ResidentSources(columns ResidentColumns, documentBlocks []byte) ([]SectionSource, error) {
	idSample, err := idSampleSection(columns.IDSample)
	if err != nil {
		return nil, err
	}
	return []SectionSource{
		BytesSection("tokens", columns.Tokens),
		BytesSection("tokenOffsets", columns.TokenOffsets),
		BytesSection("documentFrequencies", columns.DocumentFrequencies),
		BytesSection("postingOffsets", columns.PostingOffsets),
		BytesSection("blockLists", columns.BlockLists),
		BytesSection("blockListOffsets", columns.BlockListOffsets),
		BytesSection("blockSummaries", columns.BlockSummaries),
		BytesSection("fieldLengths", encodeColumns(func(chunks *keyword.Chunks) { chunks.FieldLengths(columns.FieldLengths) })),
		BytesSection("numeric", encodeColumns(func(chunks *keyword.Chunks) { chunks.ValueColumns(columns.Numeric) })),
		BytesSection("sizes", encodeColumns(func(chunks *keyword.Chunks) { chunks.ValueColumns(columns.Sizes) })),
		BytesSection("boolean", encodeColumns(func(chunks *keyword.Chunks) { chunks.BooleanColumns(columns.Boolean) })),
		BytesSection("enum", encodeColumns(func(chunks *keyword.Chunks) { chunks.EnumColumns(columns.Enum) })),
		BytesSection("geopoint", encodeColumns(func(chunks *keyword.Chunks) { chunks.GeopointColumns(columns.Geopoint) })),
		BytesSection("pattern", encodeColumns(func(chunks *keyword.Chunks) { chunks.PatternColumns(columns.Pattern) })),
		BytesSection("partialWords", encodeColumns(func(chunks *keyword.Chunks) { chunks.PartialWords(columns.PartialWords) })),
		BytesSection("documentBlocks", documentBlocks),
		BytesSection("idSample", idSample),
	}, nil
}

func SurfaceFormSource(column *keyword.SurfaceFormColumn) SectionSource {
	return BytesSection("surfaceForms", encodeColumns(func(chunks *keyword.Chunks) { chunks.SurfaceForms(column) }))
}

type DocumentBlockWriter struct {
	emit    func(compressed []byte) error
	blocks  []byte
	pending []byte
	first   int
	next    int
	written uint64
}

func NewDocumentBlockWriter(emit func(compressed []byte) error) *DocumentBlockWriter {
	return &DocumentBlockWriter{emit: emit}
}

func (writer *DocumentBlockWriter) closeBlock() error {
	if len(writer.pending) == 0 {
		return nil
	}
	deflated, err := DeflateBlock(writer.pending)
	if err != nil {
		return narsilerr.Wrap(narsilerr.CodePersistenceSaveFailed, "A document block fails to compress", err, nil)
	}
	writer.blocks = binary.LittleEndian.AppendUint32(writer.blocks, uint32(writer.first))
	writer.blocks = binary.LittleEndian.AppendUint64(writer.blocks, writer.written)
	writer.blocks = binary.LittleEndian.AppendUint32(writer.blocks, uint32(len(deflated)))
	writer.blocks = binary.LittleEndian.AppendUint32(writer.blocks, uint32(len(writer.pending)))
	writer.written += uint64(len(deflated))
	writer.pending = writer.pending[:0]
	return writer.emit(deflated)
}

func (writer *DocumentBlockWriter) Add(document []byte) error {
	if len(writer.pending) == 0 {
		writer.first = writer.next
	}
	writer.next++
	writer.pending = append(writer.pending, document...)
	if len(writer.pending) >= DocumentBlockMinRawBytes {
		return writer.closeBlock()
	}
	return nil
}

func (writer *DocumentBlockWriter) Finish() ([]byte, error) {
	if err := writer.closeBlock(); err != nil {
		return nil, err
	}
	return writer.blocks, nil
}
