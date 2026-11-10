package segments

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"math"
	"slices"
	"strings"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/keyword"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/segment"
)

var emptyMessagePackMap = []byte{0x80}

type PagedDocuments struct {
	Schema    map[string]string
	IDs       []string
	Documents [][]byte
}

func uint32Column(values []uint32) keyword.Uint32s {
	return keyword.Uint32sOf(values...)
}

func uint16Column(values []uint16) keyword.Uint16s {
	column := make([]byte, 0, len(values)*keyword.Uint16Bytes)
	for _, value := range values {
		column = binary.LittleEndian.AppendUint16(column, value)
	}
	return column
}

func entriesOf(entries [][]byte) ([]byte, keyword.Uint32s, error) {
	var joined []byte
	offsets := make([]uint32, 1, len(entries)+1)
	for _, entry := range entries {
		joined = append(joined, entry...)
		if uint64(len(joined)) > math.MaxUint32 {
			return nil, nil, ErrSegmentFull
		}
		offsets = append(offsets, uint32(len(joined)))
	}
	return joined, uint32Column(offsets), nil
}

func idColumns(ids []string) ([]byte, keyword.Uint32s, keyword.Uint32s, error) {
	encoded := make([][]byte, len(ids))
	order := make([]uint32, len(ids))
	for at, id := range ids {
		encoded[at] = []byte(id)
		order[at] = uint32(at)
	}
	slices.SortStableFunc(order, func(left, right uint32) int {
		return strings.Compare(ids[left], ids[right])
	})
	joined, offsets, err := entriesOf(encoded)
	return joined, offsets, uint32Column(order), err
}

func (k *Keyword) partialColumn() *keyword.PartialWordColumn {
	spellings := k.Segment.Spellings
	if len(k.PartialFieldNames) == 0 || spellings == nil {
		return nil
	}
	return &keyword.PartialWordColumn{
		Fields:     slices.Clone(k.PartialFieldNames),
		Text:       spellings.Text,
		Offsets:    uint32Column(spellings.Offsets),
		Tokens:     uint32Column(k.Segment.SpellingTokens),
		Counts:     uint32Column(spellings.Counts),
		Runs:       uint32Column(k.SpellingRuns.Points),
		RunOffsets: uint32Column(k.SpellingRuns.Offsets),
		RunEntries: uint32Column(k.SpellingRuns.Members),
	}
}

func (k *Keyword) keywordSegment(documents PagedDocuments) (*keyword.Segment, error) {
	frozen := &k.Segment
	count := int(frozen.DocumentCount)
	if len(documents.IDs) != count || (documents.Documents != nil && len(documents.Documents) != count) {
		return nil, fmt.Errorf("%w: the paged segment needs one ID and one document per ordinal", ErrInvalidInput)
	}
	ids, idOffsets, idOrder, err := idColumns(documents.IDs)
	if err != nil {
		return nil, err
	}
	stored := documents.Documents
	if stored == nil {
		stored = make([][]byte, count)
		for at := range stored {
			stored[at] = emptyMessagePackMap
		}
	}
	encoded, documentOffsets, err := entriesOf(stored)
	if err != nil {
		return nil, err
	}
	built := &keyword.Segment{
		Schema: documents.Schema, DocumentCount: frozen.DocumentCount,
		IDs: ids, IDOffsets: idOffsets, IDOrder: idOrder, Documents: encoded, DocumentOffsets: documentOffsets,
		FieldNames: slices.Clone(k.FieldNames), Tokens: frozen.Terms.Text,
		TokenOffsets: uint32Column(frozen.Terms.Offsets), DocumentFrequencies: uint32Column(frozen.Terms.Counts),
		PostingOffsets: uint32Column(frozen.PostingOffsets), PostingDocuments: uint32Column(frozen.PostingDocuments),
		PostingFrequencies: uint16Column(frozen.PostingFrequencies), PostingFields: uint16Column(frozen.PostingFields),
		PartialWords: k.partialColumn(),
	}
	if built.Schema == nil {
		built.Schema = map[string]string{}
	}
	if k.PositionOffsets != nil {
		built.TracksPositions = true
		built.PositionOffsets = uint32Column(k.PositionOffsets)
		built.Positions = uint32Column(k.PositionValues)
	}
	for field, name := range k.FieldNames {
		if field < len(k.FieldLengths) && len(k.FieldLengths[field]) > 0 {
			built.FieldLengths = append(built.FieldLengths,
				keyword.FieldLengthColumn{Field: name, Lengths: uint32Column(k.FieldLengths[field])})
		}
	}
	if surfaces := frozen.Surfaces; surfaces != nil {
		built.SurfaceForms = &keyword.SurfaceFormColumn{Text: surfaces.Text, Offsets: uint32Column(surfaces.Offsets),
			Counts: uint32Column(surfaces.Counts)}
	}
	return built, nil
}

func WritePaged(ctx context.Context, writer io.Writer, scratchPath string, frozen *Keyword,
	documents PagedDocuments) (int64, error) {
	built, err := frozen.keywordSegment(documents)
	if err != nil {
		return 0, err
	}
	written, err := segment.WritePaged(ctx, writer, scratchPath, built)
	if err != nil {
		return 0, err
	}
	return written.Bytes, nil
}
