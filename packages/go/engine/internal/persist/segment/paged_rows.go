package segment

import (
	"encoding/binary"
	"fmt"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/paged"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/segments"
)

const (
	postingDocumentBytes  = 4
	postingFrequencyBytes = 2
)

type pagedRows struct {
	bytes       []byte
	documents   []uint32
	frequencies []uint16
	fields      []uint16
}

type termRows struct {
	inputs           []core.KeywordMergeInput
	rowCapacity      uint64
	positionCapacity uint64
	output           core.PostingMergeOutput
	count            uint32
}

func (rows *termRows) clear() {
	rows.inputs = rows.inputs[:0]
	rows.rowCapacity, rows.positionCapacity, rows.count = 0, 0, 0
}

func corruptedRows(input int, slot uint32) error {
	return fmt.Errorf("%w: input %d of the merge holds no posting list %d", segments.ErrInvalidInput, input, slot)
}

func (rows *termRows) appendResident(source *core.KeywordMergeInput, held *mergedInput, at int, slot uint32) error {
	segment := &held.keyword.Segment
	offsets := segment.PostingOffsets
	if uint64(slot)+1 >= uint64(len(offsets)) || offsets[slot] > offsets[slot+1] ||
		uint64(offsets[slot+1]) > uint64(len(segment.PostingDocuments)) {
		return corruptedRows(at, slot)
	}
	start, end := offsets[slot], offsets[slot+1]
	source.PostingDocuments = segment.PostingDocuments[start:end]
	source.PostingFrequencies = segment.PostingFrequencies[start:end]
	source.PostingFields = segment.PostingFields[start:end]
	if positions := held.keyword.PositionOffsets; positions != nil {
		if uint64(end) >= uint64(len(positions)) {
			return corruptedRows(at, slot)
		}
		source.PositionOffsets = positions[start : end+1]
		source.PositionValues = held.keyword.PositionValues
		if source.PositionValues == nil {
			source.PositionValues = []uint32{}
		}
		rows.positionCapacity += uint64(positions[end] - positions[start])
	}
	return nil
}

func (rows *termRows) appendPaged(w *core.Workspace, source *core.KeywordMergeInput, held *mergedInput, at int,
	slot uint32) error {
	offsets := held.keyword.Segment.PostingOffsets
	if uint64(slot)+1 >= uint64(len(offsets)) || offsets[slot] > offsets[slot+1] {
		return corruptedRows(at, slot)
	}
	count := int(offsets[slot+1] - offsets[slot])
	read := &held.read
	if need := count * paged.PostingWidthBytes; cap(read.bytes) < need {
		read.bytes = make([]byte, need)
	}
	if _, err := held.Paged.ReadPostings(w, slot, read.bytes[:count*paged.PostingWidthBytes]); err != nil {
		return err
	}
	frequencies := read.bytes[count*postingDocumentBytes:]
	fields := frequencies[count*postingFrequencyBytes:]
	read.documents, read.frequencies, read.fields = read.documents[:0], read.frequencies[:0], read.fields[:0]
	for row := range count {
		read.documents = append(read.documents, binary.LittleEndian.Uint32(read.bytes[row*postingDocumentBytes:]))
		read.frequencies = append(read.frequencies, binary.LittleEndian.Uint16(frequencies[row*postingFrequencyBytes:]))
		read.fields = append(read.fields, binary.LittleEndian.Uint16(fields[row*postingFrequencyBytes:]))
	}
	source.PostingDocuments, source.PostingFrequencies, source.PostingFields = read.documents, read.frequencies,
		read.fields
	if !held.Paged.TracksPositions() {
		return nil
	}
	starts, values, tracked, err := held.Paged.ReadPositions(slot)
	if err != nil || !tracked {
		return err
	}
	if len(starts) != count+1 {
		return corruptedRows(at, slot)
	}
	source.PositionOffsets, source.PositionValues = starts, values
	if values == nil {
		source.PositionValues = []uint32{}
	}
	rows.positionCapacity += uint64(starts[count] - starts[0])
	return nil
}

func (rows *termRows) appendFrom(w *core.Workspace, merge *streamedMerge, at int, sorted int) error {
	held := &merge.inputs[at]
	slot := uint32(sorted)
	if sorted < len(held.keyword.Segment.PayloadSlots) {
		slot = held.keyword.Segment.PayloadSlots[sorted]
	}
	source := held.template
	var err error
	if held.Paged != nil {
		err = rows.appendPaged(w, &source, held, at, slot)
	} else {
		err = rows.appendResident(&source, held, at, slot)
	}
	if err != nil {
		return err
	}
	rows.inputs = append(rows.inputs, source)
	rows.rowCapacity += uint64(len(source.PostingDocuments))
	return nil
}

func (rows *termRows) reserve() {
	output := &rows.output
	if rows.rowCapacity > uint64(len(output.Documents)) {
		capacity := max(rows.rowCapacity, uint64(len(output.Documents))*2)
		output.Documents = make([]uint32, capacity)
		output.Frequencies = make([]uint16, capacity)
		output.Fields = make([]uint16, capacity)
		output.PositionOffsets = make([]uint32, capacity+1)
	}
	if len(output.PositionOffsets) == 0 {
		output.PositionOffsets = make([]uint32, 1)
	}
	if want := max(rows.positionCapacity, 1); want > uint64(len(output.Positions)) {
		output.Positions = make([]uint32, max(want, uint64(len(output.Positions))*2))
	}
	if len(output.Totals) != core.PostingMergeTotals {
		output.Totals = make([]float64, core.PostingMergeTotals)
	}
}

func (rows *termRows) finish(w *core.Workspace, merge *streamedMerge) error {
	rows.reserve()
	request := &core.KeywordMergeRequest{Inputs: rows.inputs, DocumentCount: merge.documentCount,
		FieldCount: uint32(len(merge.fieldNames))}
	count, err := segments.MergePostings(w, request, &rows.output)
	if err != nil {
		return err
	}
	rows.count = count
	return nil
}

func (rows *termRows) written(tracksPositions bool) (*tokenRows, error) {
	count := rows.count
	output := &rows.output
	written := &tokenRows{documents: output.Documents[:count], frequencies: output.Frequencies[:count],
		fields: output.Fields[:count], starts: output.PositionOffsets[:count+1]}
	if !tracksPositions {
		return written, nil
	}
	if uint64(output.PositionOffsets[count]) > uint64(len(output.Positions)) {
		return nil, fmt.Errorf("%w: the merged positions pass the room the merge gave them", segments.ErrInvalidInput)
	}
	written.positions = output.Positions[:output.PositionOffsets[count]]
	return written, nil
}
