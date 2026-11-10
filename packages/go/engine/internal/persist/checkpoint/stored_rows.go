package checkpoint

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/keyword"
)

type RowVisitor func(ordinal uint32, frequency uint16, field uint16, positions []uint32)

func positionsOf(values keyword.Uint32s, from uint32, to uint32, scratch []uint32) []uint32 {
	scratch = scratch[:0]
	for at := from; at < to; at++ {
		scratch = append(scratch, values.At(int(at)))
	}
	return scratch
}

func (stored keywordStored) FieldNames() []string { return stored.segment.FieldNames }

func (stored keywordStored) TracksPositions() bool { return stored.segment.TracksPositions }

func (stored keywordStored) TokenCount() int { return stored.segment.TokenCount() }

func (stored keywordStored) Token(at int) string { return stored.segment.Token(at) }

func (stored keywordStored) FieldLengthColumns() []keyword.FieldLengthColumn {
	return stored.segment.FieldLengths
}

func (stored keywordStored) SurfaceForms() (*keyword.SurfaceFormColumn, error) {
	return stored.segment.SurfaceForms, nil
}

func (stored keywordStored) VisitRows(at int, visit RowVisitor) error {
	segment := stored.segment
	from, to := int(segment.PostingOffsets.At(at)), int(segment.PostingOffsets.At(at+1))
	var scratch []uint32
	for row := from; row < to; row++ {
		var positions []uint32
		if segment.TracksPositions {
			scratch = positionsOf(segment.Positions, segment.PositionOffsets.At(row), segment.PositionOffsets.At(row+1),
				scratch)
			positions = scratch
		}
		visit(segment.PostingDocuments.At(row), segment.PostingFrequencies.At(row), segment.PostingFields.At(row), positions)
	}
	return nil
}

func (stored pagedStored) FieldNames() []string { return stored.reader.Head.FieldNames }

func (stored pagedStored) TracksPositions() bool { return stored.reader.Resident.TracksPositions }

func (stored pagedStored) TokenCount() int { return stored.reader.TokenCount() }

func (stored pagedStored) Token(at int) string {
	resident := stored.reader.Resident
	return string(resident.Tokens[resident.TokenOffsets.At(at):resident.TokenOffsets.At(at+1)])
}

func (stored pagedStored) FieldLengthColumns() []keyword.FieldLengthColumn {
	return stored.reader.Resident.FieldLengths
}

func (stored pagedStored) SurfaceForms() (*keyword.SurfaceFormColumn, error) {
	return stored.reader.SurfaceForms()
}

func (stored pagedStored) VisitRows(at int, visit RowVisitor) error {
	list, err := stored.reader.PostingList(at)
	if err != nil {
		return err
	}
	positions, tracks, err := stored.reader.Positions(at)
	if err != nil {
		return err
	}
	var scratch []uint32
	for row := range list.Documents.Len() {
		var held []uint32
		if tracks {
			values := positions.Row(row)
			scratch = positionsOf(values, 0, uint32(values.Len()), scratch)
			held = scratch
		}
		visit(list.Documents.At(row), list.Frequencies.At(row), list.Fields.At(row), held)
	}
	return nil
}
