package segment

import (
	"context"
	"encoding/binary"
	"math"
	"slices"
	"strings"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/paged"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/segments"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type writtenDocuments struct {
	documents    *sectionSink
	ids          *sectionSink
	idOffsets    *sectionSink
	idOrder      *sectionSink
	seqNos       *sectionSink
	primaryTerms *sectionSink
	blocks       []byte
	idSample     []paged.IDSampleEntry
	residentIDs  [][]string
}

func (stream *pagedStream) openDocumentSinks(keepsRecords bool) (*writtenDocuments, error) {
	written := &writtenDocuments{}
	var err error
	for _, opened := range []struct {
		target **sectionSink
		name   string
	}{{&written.documents, "documents"}, {&written.ids, "ids"}, {&written.idOffsets, "idOffsets"},
		{&written.idOrder, "idOrder"}} {
		if *opened.target, err = stream.sink(opened.name); err != nil {
			return nil, err
		}
	}
	if !keepsRecords {
		return written, nil
	}
	if written.seqNos, err = stream.sink("seqNos"); err != nil {
		return nil, err
	}
	written.primaryTerms, err = stream.sink("primaryTerms")
	return written, err
}

func (written *writtenDocuments) writeRecord(input *mergedInput, ordinal uint32) error {
	if written.seqNos == nil {
		return nil
	}
	seqNo, primaryTerm, err := input.Paged.WriteRecord(ordinal)
	if err != nil {
		return err
	}
	if err := written.seqNos.write(binary.LittleEndian.AppendUint64(nil, seqNo)); err != nil {
		return err
	}
	return written.primaryTerms.write(binary.LittleEndian.AppendUint64(nil, primaryTerm))
}

func (stream *pagedStream) writeDocuments(ctx context.Context, merge *streamedMerge) (*writtenDocuments, error) {
	written, err := stream.openDocumentSinks(merge.keepsRecords)
	if err != nil {
		return nil, err
	}
	blocks := paged.NewDocumentBlockWriter(written.documents.write)
	if err := written.idOffsets.write(binary.LittleEndian.AppendUint32(nil, 0)); err != nil {
		return nil, err
	}
	written.residentIDs = make([][]string, len(merge.inputs))
	var idBytes uint64
	for at := range merge.inputs {
		input := &merge.inputs[at]
		if input.Paged == nil {
			written.residentIDs[at] = make([]string, len(input.mapping))
		}
		for ordinal, target := range input.mapping {
			if target == core.MergeDroppedOrdinal {
				continue
			}
			if ctx.Err() != nil {
				return nil, narsilerr.Wrap(narsilerr.CodePersistenceSaveFailed,
					"The paged keyword segment write was cancelled", ctx.Err(), nil)
			}
			id, encoded, err := input.Document(uint32(ordinal))
			if err != nil {
				return nil, err
			}
			if err := blocks.Add(encoded); err != nil {
				return nil, err
			}
			if err := written.ids.write([]byte(id)); err != nil {
				return nil, err
			}
			idBytes += uint64(len(id))
			if idBytes > math.MaxUint32 {
				return nil, segments.ErrSegmentFull
			}
			if err := written.idOffsets.write(binary.LittleEndian.AppendUint32(nil, uint32(idBytes))); err != nil {
				return nil, err
			}
			if written.residentIDs[at] != nil {
				written.residentIDs[at][ordinal] = id
			}
			if err := written.writeRecord(input, uint32(ordinal)); err != nil {
				return nil, err
			}
		}
	}
	if written.blocks, err = blocks.Finish(); err != nil {
		return nil, err
	}
	return written, stream.writeIDOrder(merge, written)
}

type idCursor struct {
	input    int
	position int
	order    []uint32
	ordinal  uint32
	id       string
}

func (written *writtenDocuments) advance(merge *streamedMerge, cursor *idCursor) (bool, error) {
	input := &merge.inputs[cursor.input]
	for {
		cursor.position++
		if cursor.position >= len(input.mapping) {
			return false, nil
		}
		ordinal, err := cursor.ordinalAt(input)
		if err != nil {
			return false, err
		}
		if uint64(ordinal) >= uint64(len(input.mapping)) || input.mapping[ordinal] == core.MergeDroppedOrdinal {
			continue
		}
		cursor.ordinal = ordinal
		if input.Paged == nil {
			cursor.id = written.residentIDs[cursor.input][ordinal]
			return true, nil
		}
		cursor.id, err = input.Paged.IDAt(ordinal)
		return err == nil, err
	}
}

func (cursor *idCursor) ordinalAt(input *mergedInput) (uint32, error) {
	if cursor.order == nil {
		return input.Paged.SortedOrdinal(uint32(cursor.position))
	}
	return cursor.order[cursor.position], nil
}

func (written *writtenDocuments) openIDCursor(merge *streamedMerge, at int) *idCursor {
	cursor := &idCursor{input: at, position: -1}
	if merge.inputs[at].Paged != nil {
		return cursor
	}
	ids := written.residentIDs[at]
	cursor.order = make([]uint32, len(ids))
	for ordinal := range cursor.order {
		cursor.order[ordinal] = uint32(ordinal)
	}
	slices.SortStableFunc(cursor.order, func(left, right uint32) int { return strings.Compare(ids[left], ids[right]) })
	return cursor
}

func (stream *pagedStream) writeIDOrder(merge *streamedMerge, written *writtenDocuments) error {
	var cursors []*idCursor
	for at := range merge.inputs {
		cursor := written.openIDCursor(merge, at)
		held, err := written.advance(merge, cursor)
		if err != nil {
			return err
		}
		if held {
			cursors = append(cursors, cursor)
		}
	}
	for position := uint32(0); len(cursors) > 0; position++ {
		least := 0
		for at := 1; at < len(cursors); at++ {
			if strings.Compare(cursors[at].id, cursors[least].id) < 0 {
				least = at
			}
		}
		cursor := cursors[least]
		target := merge.inputs[cursor.input].mapping[cursor.ordinal]
		if err := written.idOrder.write(binary.LittleEndian.AppendUint32(nil, target)); err != nil {
			return err
		}
		if position%paged.IDSampleInterval == 0 {
			written.idSample = append(written.idSample, paged.IDSampleEntry{ID: cursor.id, Position: position})
		}
		held, err := written.advance(merge, cursor)
		if err != nil {
			return err
		}
		if !held {
			cursors = slices.Delete(cursors, least, least+1)
		}
	}
	return nil
}
