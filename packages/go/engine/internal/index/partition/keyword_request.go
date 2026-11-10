package partition

import (
	"sync"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/postings"
)

type rowColumns struct {
	docIDs      []uint32
	frequencies []float64
	fields      []uint16
}

type requestBuilder struct {
	request         core.KeywordRequest
	output          core.KeywordOutput
	labels          []string
	ranks           []uint16
	ownsPool        bool
	poolDocIDs      []uint32
	poolFrequencies []uint16
	poolFields      []uint16
}

var builders = sync.Pool{New: func() any { return &requestBuilder{} }}

func acquireBuilder(pool postings.Pool) *requestBuilder {
	builder := builders.Get().(*requestBuilder)
	request := &builder.request
	*request = core.KeywordRequest{
		PoolDocIDs:      pool.DocIDs,
		PoolFrequencies: pool.Frequencies,
		PoolFields:      pool.Fields,
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
	builder.labels = builder.labels[:0]
	return builder
}

func (b *requestBuilder) release() {
	request := &b.request
	if b.ownsPool {
		b.poolDocIDs, b.poolFrequencies, b.poolFields = request.PoolDocIDs[:0], request.PoolFrequencies[:0], request.PoolFields[:0]
		b.ownsPool = false
	}
	request.PoolDocIDs, request.PoolFrequencies, request.PoolFields = nil, nil, nil
	request.Filter, request.Live, request.Removed = nil, nil, nil
	clear(request.Lengths[:cap(request.Lengths)])
	clear(b.labels[:cap(b.labels)])
	builders.Put(b)
}

func (b *requestBuilder) openSlot(kind uint32, term uint32) {
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
	request := &b.request
	request.Lists = append(request.Lists, flags, start, length)
	request.ListValues = append(request.ListValues, first, second)
	request.Slots[len(request.Slots)-core.KeywordSlotStride+core.KeywordSlotListEnd] = uint32(len(request.Lists) / core.KeywordListStride)
	b.labels = append(b.labels, label)
}

func (b *requestBuilder) termSlot(term int) {
	b.openSlot(core.KeywordTermSlot, uint32(term))
}

func (b *requestBuilder) groupSlot(term int, documentFrequency float64) {
	b.openSlot(core.KeywordGroupSlot, uint32(term))
	b.pushSlotValue(documentFrequency)
}

func (b *requestBuilder) poolList(list postings.List, first, second float64, label string) {
	flags := uint32(0)
	if list.Ordered {
		flags = core.KeywordListOrdered
	}
	start := list.Start
	if list.Detached {
		start = b.appendToPool(list)
	}
	b.pushList(flags, start, uint32(list.Length()), first, second, label)
}

func (b *requestBuilder) appendToPool(list postings.List) uint32 {
	request := &b.request
	if !b.ownsPool {
		b.ownsPool = true
		request.PoolDocIDs = append(b.poolDocIDs[:0], request.PoolDocIDs...)
		request.PoolFrequencies = append(b.poolFrequencies[:0], request.PoolFrequencies...)
		request.PoolFields = append(b.poolFields[:0], request.PoolFields...)
	}
	start := uint32(len(request.PoolDocIDs))
	request.PoolDocIDs = append(request.PoolDocIDs, list.DocIDs...)
	request.PoolFrequencies = append(request.PoolFrequencies, list.Frequencies...)
	request.PoolFields = append(request.PoolFields, list.Fields...)
	return start
}

func (b *requestBuilder) rowList(rows rowColumns, ordered bool, first, second float64, label string) {
	request := &b.request
	start := uint32(len(request.RowDocIDs))
	request.RowDocIDs = append(request.RowDocIDs, rows.docIDs...)
	request.RowFrequencies = append(request.RowFrequencies, rows.frequencies...)
	request.RowFields = append(request.RowFields, rows.fields...)
	flags := uint32(core.KeywordListFromRows)
	if ordered {
		flags |= core.KeywordListOrdered
	}
	b.pushList(flags, start, uint32(len(rows.docIDs)), first, second, label)
}

func (b *requestBuilder) phraseSlot(documentFrequencies []float64, rows rowColumns, label string) {
	b.openSlot(core.KeywordPhraseSlot, 0)
	for _, frequency := range documentFrequencies {
		b.pushSlotValue(frequency)
	}
	ordered := true
	for row := 1; row < len(rows.docIDs); row++ {
		if rows.docIDs[row] < rows.docIDs[row-1] {
			ordered = false
		}
	}
	b.rowList(rows, ordered, 0, 0, label)
}

func (b *requestBuilder) sizeOutput(capacity uint32) *core.KeywordOutput {
	output := &b.output
	if len(output.Ordinals) < int(capacity) {
		output.Ordinals = make([]int32, capacity)
		output.Scores = make([]float64, capacity)
	}
	words := max(1, (int(capacity)+31)>>5)
	if len(output.Matched) < words {
		output.Matched = make([]uint32, words)
	}
	return output
}
