package fieldindex

import "github.com/assetcorp/narsil/packages/go/engine/internal/index/bitset"

type booleanPostings struct {
	order     insertionOrder
	positions []uint32
}

func (postings *booleanPostings) add(ordinal uint32) {
	if ordinal == vacantOrdinal {
		return
	}
	if int(ordinal) < len(postings.positions) && postings.positions[ordinal] != 0 {
		return
	}
	position := postings.order.push(ordinal)
	postings.positions = grownPositions(postings.positions, ordinal)
	postings.positions[ordinal] = position + 1
}

func (postings *booleanPostings) remove(ordinal uint32) {
	if int(ordinal) >= len(postings.positions) || postings.positions[ordinal] == 0 {
		return
	}
	postings.order.vacate(postings.positions[ordinal] - 1)
	postings.positions[ordinal] = 0
	if postings.order.crowded() {
		postings.order.compact(postings.moved)
	}
}

func (postings *booleanPostings) moved(ordinal, position uint32) {
	postings.positions[ordinal] = position + 1
}

type Boolean struct {
	trueDocuments  booleanPostings
	falseDocuments booleanPostings
}

func NewBoolean() *Boolean {
	return &Boolean{}
}

func (index *Boolean) postingsOf(value bool) *booleanPostings {
	if value {
		return &index.trueDocuments
	}
	return &index.falseDocuments
}

func (index *Boolean) Insert(ordinal uint32, value bool) {
	index.postingsOf(value).add(ordinal)
}

func (index *Boolean) Remove(ordinal uint32, value bool) {
	index.postingsOf(value).remove(ordinal)
}

func (index *Boolean) Clear() {
	index.trueDocuments = booleanPostings{}
	index.falseDocuments = booleanPostings{}
}

func (index *Boolean) Load(trueOrdinals, falseOrdinals []uint32) {
	index.Clear()
	for _, ordinal := range trueOrdinals {
		index.trueDocuments.add(ordinal)
	}
	for _, ordinal := range falseOrdinals {
		index.falseDocuments.add(ordinal)
	}
}

func (index *Boolean) Ordinals() (trueOrdinals, falseOrdinals []uint32) {
	trueOrdinals = index.trueDocuments.order.appendLive(make([]uint32, 0, index.trueDocuments.order.live))
	falseOrdinals = index.falseDocuments.order.appendLive(make([]uint32, 0, index.falseDocuments.order.live))
	return trueOrdinals, falseOrdinals
}

func (index *Boolean) EqualInto(value bool, into bitset.Bits) {
	index.postingsOf(value).order.setInto(into)
}

func (index *Boolean) AllInto(into bitset.Bits) {
	index.trueDocuments.order.setInto(into)
	index.falseDocuments.order.setInto(into)
}

func (index *Boolean) Counts(matched bitset.Bits) (trueCount, falseCount int) {
	return index.trueDocuments.order.countMatched(matched), index.falseDocuments.order.countMatched(matched)
}

func (index *Boolean) EstimateBytes(documentCount int) int64 {
	return estimatedFieldBytes(documentCount)
}
