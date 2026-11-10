package partition

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/segments"
)

const (
	byteWidth      = 1
	halfWordBytes  = 2
	wordBytes      = 4
	numberBytes    = 8
	idOverheadByte = 16
)

func lengthBytes[T any](values []T, width uint64) uint64 {
	return uint64(len(values)) * width
}

func frozenStringsBytes(strings *core.FrozenStrings) uint64 {
	if strings == nil {
		return 0
	}
	return lengthBytes(strings.Text, byteWidth) + lengthBytes(strings.Offsets, wordBytes) + lengthBytes(strings.Counts, wordBytes)
}

func frozenCoreBytes(segment *core.FrozenSegment) uint64 {
	bytes := frozenStringsBytes(&segment.Terms) + frozenStringsBytes(segment.Surfaces) + frozenStringsBytes(segment.Spellings)
	bytes += lengthBytes(segment.PayloadSlots, wordBytes) + lengthBytes(segment.PostingOffsets, wordBytes)
	bytes += lengthBytes(segment.PostingDocuments, wordBytes) + lengthBytes(segment.SpellingTokens, wordBytes)
	bytes += lengthBytes(segment.PostingFrequencies, halfWordBytes) + lengthBytes(segment.PostingFields, halfWordBytes)
	return bytes + lengthBytes(segment.PartialFields, byteWidth)
}

func keywordBytes(keyword *segments.Keyword) uint64 {
	bytes := frozenCoreBytes(&keyword.Segment)
	for _, lengths := range keyword.FieldLengths {
		bytes += lengthBytes(lengths, wordBytes)
	}
	bytes += lengthBytes(keyword.TotalFieldLengths, numberBytes)
	bytes += lengthBytes(keyword.PositionOffsets, wordBytes) + lengthBytes(keyword.PositionValues, wordBytes)
	runs := &keyword.SpellingRuns
	return bytes + lengthBytes(runs.Points, wordBytes) + lengthBytes(runs.Offsets, wordBytes) + lengthBytes(runs.Members, wordBytes)
}

func storedSlicesBytes(stored *core.StoredValueSlices) uint64 {
	bytes := lengthBytes(stored.Shapes, byteWidth) + lengthBytes(stored.Starts, wordBytes) + lengthBytes(stored.Kinds, byteWidth)
	bytes += lengthBytes(stored.Numbers, numberBytes) + lengthBytes(stored.TextStart, wordBytes)
	bytes += lengthBytes(stored.TextLength, wordBytes) + lengthBytes(stored.Units, halfWordBytes)
	return bytes + lengthBytes(stored.Bytes, byteWidth)
}

func numericFieldBytes(entries []segments.Field[*core.NumericIndex]) uint64 {
	var bytes uint64
	for _, entry := range entries {
		bytes += lengthBytes(entry.Index.Values, numberBytes) + lengthBytes(entry.Index.Ordinals, wordBytes)
	}
	return bytes
}

func frozenFieldBytes(held *segments.FrozenFields) uint64 {
	bytes := numericFieldBytes(held.Numeric) + numericFieldBytes(held.Sizes)
	for _, entry := range held.Boolean {
		bytes += lengthBytes(entry.Index.TrueBits, wordBytes) + lengthBytes(entry.Index.FalseBits, wordBytes)
	}
	for _, entry := range held.Enum {
		index := entry.Index
		bytes += lengthBytes(index.Units, halfWordBytes) + lengthBytes(index.Offsets, wordBytes)
		bytes += lengthBytes(index.PostingOffsets, wordBytes) + lengthBytes(index.Postings, wordBytes)
		bytes += lengthBytes(index.SuffixOrder, wordBytes)
	}
	for _, entry := range held.Geo {
		index := entry.Index
		bytes += lengthBytes(index.Codes, numberBytes) + lengthBytes(index.Lat, numberBytes)
		bytes += lengthBytes(index.Lon, numberBytes) + lengthBytes(index.Ordinals, wordBytes)
	}
	for _, entry := range held.Pattern {
		index := entry.Index
		bytes += lengthBytes(index.Documents, wordBytes) + lengthBytes(index.Runs, wordBytes)
		bytes += lengthBytes(index.Offsets, wordBytes) + lengthBytes(index.Postings, wordBytes)
	}
	for _, entry := range held.Stored {
		bytes += storedSlicesBytes(entry.Index)
	}
	return bytes
}

func (c *frozenColumns) regionBytes() uint64 {
	if c == nil {
		return 0
	}
	var bytes uint64
	for _, stored := range c.stored {
		bytes += stored.RegionBytes()
	}
	for _, column := range c.sorts {
		bytes += column.RegionBytes()
	}
	return bytes
}

func pagedHeldBytes(paged *segments.Paged) uint64 {
	if paged == nil {
		return 0
	}
	var bytes uint64
	if paged.Removals != nil {
		bytes += uint64(paged.Removals.Cache.Slots()) * core.PageSlotBytes
	}
	for _, id := range paged.Tombstones() {
		bytes += uint64(len(id)) + idOverheadByte
	}
	return bytes
}

func (f *frozenSegment) estimatedBytes() uint64 {
	bytes := keywordBytes(f.keyword()) + frozenFieldBytes(&f.frozen.Fields) + f.columns.Load().regionBytes()
	bytes += pagedHeldBytes(f.paged)
	for at, id := range f.ids {
		bytes += uint64(len(id)) + idOverheadByte
		if at < len(f.documents) {
			bytes += uint64(len(f.documents[at]))
		}
	}
	return bytes
}

func (f *frozenSide) removalBytes() uint64 {
	if f.state == nil {
		return 0
	}
	held := &f.state.Core
	bytes := lengthBytes(held.Tombstones, wordBytes) + lengthBytes(held.TombstoneCount, wordBytes)
	bytes += lengthBytes(held.RemovedDocuments, wordBytes) + lengthBytes(held.RemovedOccurrences, numberBytes)
	bytes += lengthBytes(held.RemovedSurfaces, wordBytes) + lengthBytes(held.RemovedSpellings, wordBytes)
	bytes += lengthBytes(held.PendingHeader, wordBytes) + lengthBytes(held.PendingDocuments, wordBytes)
	bytes += lengthBytes(held.PendingTokens, wordBytes) + lengthBytes(held.PendingUnits, halfWordBytes)
	return bytes + lengthBytes(f.totals, numberBytes)
}

func (s *side) growingDocumentBytes() uint64 {
	var bytes uint64
	for id, ordinal := range s.ids {
		bytes += uint64(len(id)) + idOverheadByte
		if document, held := s.gen.documents.at(s.index, ordinal); held {
			bytes += uint64(len(document.encoded))
		}
	}
	return bytes
}

func (s Snapshot) EstimatedBytes() uint64 {
	held := s.side
	bytes := held.growing.Bytes() + held.fields.RegionBytes() + held.growingDocumentBytes()
	for at := range held.frozen {
		bytes += held.frozen[at].segment.estimatedBytes() + held.frozen[at].removalBytes()
	}
	return bytes
}
