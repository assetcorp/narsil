package segment

import (
	"bytes"
	"context"
	"encoding/binary"
	"math"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/paged"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type streamedLists struct {
	postings         *sectionSink
	tokenTotals      *sectionSink
	positionOffsets  *sectionSink
	positions        *sectionSink
	tokens           []byte
	tokenOffsets     []uint32
	frequencies      []uint32
	postingOffsets   []byte
	blockLists       []byte
	blockListOffsets []byte
	blockSummaries   []byte
}

type termCursor struct {
	input int
	at    int
}

func (lists *streamedLists) terms() core.FrozenStrings {
	return core.FrozenStrings{Text: lists.tokens, Offsets: lists.tokenOffsets, Counts: lists.frequencies}
}

func postingUpperBound(merge *streamedMerge) int64 {
	var total int64
	for _, input := range merge.inputs {
		if offsets := input.keyword.Segment.PostingOffsets; len(offsets) > 0 {
			total += int64(offsets[len(offsets)-1])
		}
	}
	return total
}

func (stream *pagedStream) openLists(merge *streamedMerge) (*streamedLists, error) {
	lists := &streamedLists{tokenOffsets: []uint32{0}, postingOffsets: binary.LittleEndian.AppendUint32(nil, 0),
		blockListOffsets: binary.LittleEndian.AppendUint32(nil, 0)}
	var err error
	if lists.postings, err = stream.sink("postings"); err != nil {
		return nil, err
	}
	if lists.tokenTotals, err = stream.sink("tokenTotals"); err != nil {
		return nil, err
	}
	if merge.tracksPositions {
		if lists.positionOffsets, err = stream.sink("positionOffsets"); err != nil {
			return nil, err
		}
		if lists.positions, err = stream.sink("positions"); err != nil {
			return nil, err
		}
	}
	stream.removals, err = openRemovalSpill(stream.scratchPath, int(merge.documentCount), postingUpperBound(merge))
	return lists, err
}

func (lists *streamedLists) writeRows(rows *tokenRows, positionsWritten uint32, buffer []byte) ([]byte, error) {
	buffer = buffer[:0]
	for _, document := range rows.documents {
		buffer = binary.LittleEndian.AppendUint32(buffer, document)
	}
	for _, frequency := range rows.frequencies {
		buffer = binary.LittleEndian.AppendUint16(buffer, frequency)
	}
	for _, field := range rows.fields {
		buffer = binary.LittleEndian.AppendUint16(buffer, field)
	}
	if err := lists.postings.write(buffer); err != nil {
		return buffer, err
	}
	if lists.positionOffsets == nil {
		return buffer, nil
	}
	buffer = buffer[:0]
	for at := range rows.documents {
		buffer = binary.LittleEndian.AppendUint32(buffer, positionsWritten+rows.starts[at])
	}
	if err := lists.positionOffsets.write(buffer); err != nil {
		return buffer, err
	}
	buffer = buffer[:0]
	for _, position := range rows.positions {
		buffer = binary.LittleEndian.AppendUint32(buffer, position)
	}
	return buffer, lists.positions.write(buffer)
}

func (stream *pagedStream) addRemovals(rows *tokenRows, token uint32) error {
	for at := 0; at < len(rows.documents); {
		ordinal := rows.documents[at]
		occurrences := uint32(0)
		for at < len(rows.documents) && rows.documents[at] == ordinal {
			occurrences += uint32(rows.frequencies[at])
			at++
		}
		if err := stream.removals.add(ordinal, token, occurrences); err != nil {
			return err
		}
	}
	return nil
}

func (merge *streamedMerge) termText(cursor termCursor) []byte {
	terms := &merge.inputs[cursor.input].keyword.Segment.Terms
	return terms.Text[terms.Offsets[cursor.at]:terms.Offsets[cursor.at+1]]
}

func (merge *streamedMerge) openCursors() []termCursor {
	var cursors []termCursor
	for at := range merge.inputs {
		if len(merge.inputs[at].keyword.Segment.Terms.Counts) > 0 {
			cursors = append(cursors, termCursor{input: at})
		}
	}
	return cursors
}

func (merge *streamedMerge) gatherTerm(w *core.Workspace, cursors []termCursor, rows *termRows) ([]byte,
	[]termCursor, error) {
	smallest := merge.termText(cursors[0])
	for _, cursor := range cursors[1:] {
		if text := merge.termText(cursor); bytes.Compare(text, smallest) < 0 {
			smallest = text
		}
	}
	rows.clear()
	kept := cursors[:0]
	for _, cursor := range cursors {
		if bytes.Equal(merge.termText(cursor), smallest) {
			if err := rows.appendFrom(w, merge, cursor.input, cursor.at); err != nil {
				return nil, nil, err
			}
			cursor.at++
		}
		if cursor.at < len(merge.inputs[cursor.input].keyword.Segment.Terms.Counts) {
			kept = append(kept, cursor)
		}
	}
	return smallest, kept, rows.finish(w, merge)
}

func (stream *pagedStream) writeTerm(lists *streamedLists, rows *tokenRows, totals []float64, columns [][]uint32,
	positionsWritten uint32, buffer []byte) ([]byte, error) {
	token := uint32(len(lists.frequencies))
	lists.frequencies = append(lists.frequencies, uint32(totals[0]))
	buffer, err := lists.writeRows(rows, positionsWritten, buffer)
	if err != nil {
		return buffer, err
	}
	var total [8]byte
	binary.LittleEndian.PutUint64(total[:], math.Float64bits(totals[1]))
	if err := lists.tokenTotals.write(total[:]); err != nil {
		return buffer, err
	}
	if len(rows.documents) > paged.SmallestBlockPostings {
		lists.blockLists = binary.LittleEndian.AppendUint32(lists.blockLists, token)
		lists.blockSummaries = appendBlockSummaries(lists.blockSummaries, scanBlocks(rows, columns))
		lists.blockListOffsets = binary.LittleEndian.AppendUint32(lists.blockListOffsets,
			uint32(len(lists.blockSummaries)/paged.BlockSummaryBytes))
	}
	return buffer, stream.addRemovals(rows, token)
}

func (stream *pagedStream) writeLists(ctx context.Context, w *core.Workspace, merge *streamedMerge) (*streamedLists,
	error) {
	lists, err := stream.openLists(merge)
	if err != nil {
		return nil, err
	}
	columns := merge.lengthColumnsByField()
	cursors := merge.openCursors()
	rows := &termRows{}
	postingsWritten, positionsWritten := uint32(0), uint32(0)
	var buffer []byte
	for walked := 0; len(cursors) > 0; walked++ {
		if walked%pagedWriterCancelCheckTokens == 0 && ctx.Err() != nil {
			return nil, narsilerr.Wrap(narsilerr.CodePersistenceSaveFailed,
				"The paged keyword segment write was cancelled", ctx.Err(), nil)
		}
		var text []byte
		if text, cursors, err = merge.gatherTerm(w, cursors, rows); err != nil {
			return nil, err
		}
		if rows.count == 0 {
			continue
		}
		written, err := rows.written(merge.tracksPositions)
		if err != nil {
			return nil, err
		}
		lists.tokens = append(lists.tokens, text...)
		lists.tokenOffsets = append(lists.tokenOffsets, uint32(len(lists.tokens)))
		if buffer, err = stream.writeTerm(lists, written, rows.output.Totals, columns, positionsWritten,
			buffer); err != nil {
			return nil, err
		}
		positionsWritten += uint32(len(written.positions))
		postingsWritten += rows.count
		lists.postingOffsets = binary.LittleEndian.AppendUint32(lists.postingOffsets, postingsWritten)
	}
	if lists.positionOffsets != nil {
		if err := lists.positionOffsets.write(binary.LittleEndian.AppendUint32(nil, positionsWritten)); err != nil {
			return nil, err
		}
	}
	return lists, nil
}
