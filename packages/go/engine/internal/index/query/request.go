package query

import "github.com/assetcorp/narsil/packages/go/engine/internal/core"

type rowColumns struct {
	documents   []uint32
	frequencies []float64
	fields      []uint16
}

type requestBuilder struct {
	request core.KeywordRequest
	output  core.KeywordOutput
	labels  []string
}

func (b *requestBuilder) begin(segment *Segment) {
	request := &b.request
	documents, frequencies, fields := segment.pool()
	clear(b.labels)
	b.labels = b.labels[:0]
	*request = core.KeywordRequest{
		PoolDocIDs:      documents,
		PoolFrequencies: frequencies,
		PoolFields:      fields,
		RowDocIDs:       request.RowDocIDs[:0],
		RowFrequencies:  request.RowFrequencies[:0],
		RowFields:       request.RowFields[:0],
		Slots:           request.Slots[:0],
		Lists:           request.Lists[:0],
		ListValues:      request.ListValues[:0],
		SlotValues:      request.SlotValues[:0],
		Searchable:      request.Searchable[:0],
		PartialMarks:    request.PartialMarks[:0],
		NameRanks:       request.NameRanks[:0],
		FieldNumbers:    request.FieldNumbers[:0],
		Lengths:         request.Lengths[:0],
	}
}

func (b *requestBuilder) release() {
	request := &b.request
	request.PoolDocIDs, request.PoolFrequencies, request.PoolFields = nil, nil, nil
	request.Filter, request.Live, request.Removed = nil, nil, nil
	clear(request.Lengths[:cap(request.Lengths)])
}

func (b *requestBuilder) openSlot(kind, term uint32) {
	request := &b.request
	request.Slots = append(request.Slots, kind, term, uint32(len(request.Lists)/core.KeywordListStride), uint32(len(request.SlotValues)))
	request.SlotCount++
}

func (b *requestBuilder) pushSlotValue(value float64) {
	request := &b.request
	request.SlotValues = append(request.SlotValues, value)
	request.Slots[len(request.Slots)-core.KeywordSlotStride+core.KeywordSlotValueEnd] = uint32(len(request.SlotValues))
}

func (b *requestBuilder) pushList(flags, start, length uint32, first, second float64, label string) {
	b.labels = append(b.labels, label)
	request := &b.request
	request.Lists = append(request.Lists, flags, start, length)
	request.ListValues = append(request.ListValues, first, second)
	request.Slots[len(request.Slots)-core.KeywordSlotStride+core.KeywordSlotListEnd] = uint32(len(request.Lists) / core.KeywordListStride)
}

func (b *requestBuilder) termSlot(term int) {
	b.openSlot(core.KeywordTermSlot, uint32(term))
}

func (b *requestBuilder) groupSlot(term int, documentFrequency float64) {
	b.openSlot(core.KeywordGroupSlot, uint32(term))
	b.pushSlotValue(documentFrequency)
}

func orderedFlag(ordered bool) uint32 {
	if ordered {
		return core.KeywordListOrdered
	}
	return 0
}

func (b *requestBuilder) poolList(list postingList, first, second float64, label string) {
	b.pushList(orderedFlag(list.ordered), list.start, list.length, first, second, label)
}

func (b *requestBuilder) rowList(rows *rowColumns, ordered bool, first, second float64, label string) {
	request := &b.request
	start := uint32(len(request.RowDocIDs))
	request.RowDocIDs = append(request.RowDocIDs, rows.documents...)
	request.RowFrequencies = append(request.RowFrequencies, rows.frequencies...)
	request.RowFields = append(request.RowFields, rows.fields...)
	b.pushList(core.KeywordListFromRows|orderedFlag(ordered), start, uint32(len(rows.documents)), first, second, label)
}

func (b *requestBuilder) phraseSlot(documentFrequencies []float64, documents []uint32, fields []uint16, frequencies []uint32, label string) {
	b.openSlot(core.KeywordPhraseSlot, 0)
	for _, frequency := range documentFrequencies {
		b.pushSlotValue(frequency)
	}
	request := &b.request
	start := uint32(len(request.RowDocIDs))
	ordered := true
	for row, document := range documents {
		request.RowDocIDs = append(request.RowDocIDs, document)
		request.RowFields = append(request.RowFields, fields[row])
		request.RowFrequencies = append(request.RowFrequencies, float64(frequencies[row]))
		if row > 0 && document < documents[row-1] {
			ordered = false
		}
	}
	b.pushList(core.KeywordListFromRows|orderedFlag(ordered), start, uint32(len(documents)), 0, 0, label)
}

func (b *requestBuilder) sizeOutput(capacity uint32) *core.KeywordOutput {
	output := &b.output
	if len(output.Ordinals) < int(capacity) {
		output.Ordinals = make([]int32, capacity)
		output.Scores = make([]float64, capacity)
	}
	if words := bitsetWords(capacity); len(output.Matched) < words {
		output.Matched = make([]uint32, words)
	}
	return output
}
