package persist

import (
	"math"
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/envelope"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partition"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/segments"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type segmentFileGroup struct {
	selections    []partition.Selection
	documentCount int
}

func keptDocumentCount(selections []partition.Selection) int {
	count := 0
	for _, selection := range selections {
		for ordinal := range selection.DocumentCount() {
			if selection.Keeps(ordinal) {
				count++
			}
		}
	}
	return count
}

func addPerEntry(costs []float64, ordinals []uint32, bytes float64) {
	for _, ordinal := range ordinals {
		if uint64(ordinal) < uint64(len(costs)) {
			costs[ordinal] += bytes
		}
	}
}

func addPerMarked(costs []float64, words []uint32, bytes float64) {
	for ordinal := range costs {
		if word := ordinal >> 5; word < len(words) && words[word]&(1<<(ordinal&31)) != 0 {
			costs[ordinal] += bytes
		}
	}
}

func tokenTableBytes(frozen *core.FrozenSegment) int {
	return len(frozen.Terms.Text) + segmentOrdinalBytes*(len(frozen.Terms.Offsets)+len(frozen.PayloadSlots)+len(frozen.Terms.Counts))
}

func chargePostings(held *segments.Keyword, costs []float64, chargesTokens bool) {
	frozen := &held.Segment
	for row, ordinal := range frozen.PostingDocuments {
		bytes := float64(segmentPostingBytes)
		if held.PositionOffsets != nil && row+1 < len(held.PositionOffsets) {
			bytes += segmentOrdinalBytes * float64(1+held.PositionOffsets[row+1]-held.PositionOffsets[row])
		}
		costs[ordinal] += bytes
	}
	if !chargesTokens {
		return
	}
	for term := 0; term+1 < len(frozen.Terms.Offsets); term++ {
		slot := frozen.PayloadSlots[term]
		bytes := float64(frozen.Terms.Offsets[term+1]-frozen.Terms.Offsets[term]) + segmentTokenEntryBytes
		for row := frozen.PostingOffsets[slot]; row < frozen.PostingOffsets[slot+1]; row++ {
			costs[frozen.PostingDocuments[row]] += bytes
		}
	}
}

func chargeColumns(held *segments.FrozenFields, costs []float64) {
	for _, column := range held.Numeric {
		addPerEntry(costs, column.Index.Ordinals, segmentValueEntryBytes)
	}
	for _, column := range held.Sizes {
		addPerEntry(costs, column.Index.Ordinals, segmentValueEntryBytes)
	}
	for _, column := range held.Boolean {
		addPerMarked(costs, column.Index.TrueBits, segmentOrdinalBytes)
		addPerMarked(costs, column.Index.FalseBits, segmentOrdinalBytes)
	}
	for _, column := range held.Enum {
		addPerEntry(costs, column.Index.Postings, segmentOrdinalBytes)
	}
	for _, column := range held.Geo {
		addPerEntry(costs, column.Index.Ordinals, segmentGeopointEntryBytes)
	}
	for _, column := range held.Pattern {
		addPerEntry(costs, column.Index.Documents, segmentOrdinalBytes)
		addPerEntry(costs, column.Index.Postings, segmentOrdinalBytes)
	}
}

func stringsBytes(strings *core.FrozenStrings) int {
	if strings == nil {
		return 0
	}
	return len(strings.Text) + segmentOrdinalBytes*(len(strings.Offsets)+len(strings.Counts))
}

func fixedBytesOf(frozen *segments.Frozen, chargesTokens bool) float64 {
	held := &frozen.Keyword
	bytes := segmentStringHeaderBytes
	for _, name := range held.FieldNames {
		bytes += segmentStringHeaderBytes + len(name)
	}
	if !chargesTokens {
		bytes += tokenTableBytes(&held.Segment)
	}
	for _, column := range frozen.Fields.Enum {
		bytes += segmentStringHeaderBytes + segmentOrdinalBytes*len(column.Index.PostingOffsets)
		for _, value := range segments.EnumValues(column.Index) {
			bytes += segmentStringHeaderBytes + len(value)
		}
	}
	for _, column := range frozen.Fields.Pattern {
		bytes += segmentOrdinalBytes * (len(column.Index.Runs) + len(column.Index.Offsets))
	}
	if held.Segment.Surfaces == nil {
		bytes += segmentAbsentSurfaceFormsBytes
	} else {
		bytes += stringsBytes(held.Segment.Surfaces)
	}
	if spellings := held.Segment.Spellings; spellings != nil {
		bytes += stringsBytes(spellings) + segmentOrdinalBytes*(len(spellings.Counts)+len(held.Segment.SpellingTokens)+
			len(held.SpellingRuns.Points)+len(held.SpellingRuns.Offsets)+len(held.SpellingRuns.Members))
	}
	return float64(bytes)
}

type keptDocuments struct {
	selection partition.Selection
	ordinals  []uint32
	costs     []float64
}

func keptDocumentsOf(selection partition.Selection, chargesTokens bool) (keptDocuments, error) {
	frozen := selection.Source.Frozen
	count := selection.DocumentCount()
	costs := make([]float64, count)
	perDocument := float64(segmentOrdinalBytes * (3 + len(frozen.Keyword.FieldLengths)))
	for ordinal := range count {
		costs[ordinal] = perDocument
	}
	chargePostings(&frozen.Keyword, costs, chargesTokens)
	chargeColumns(&frozen.Fields, costs)
	kept := keptDocuments{selection: selection, costs: costs}
	for ordinal := range count {
		if !selection.Keeps(ordinal) {
			continue
		}
		id, encoded, err := selection.Document(ordinal)
		if err != nil {
			return keptDocuments{}, err
		}
		costs[ordinal] += float64(len(id) + len(encoded))
		kept.ordinals = append(kept.ordinals, ordinal)
	}
	return kept, nil
}

func keepingOrdinals(selection partition.Selection, ordinals []uint32) partition.Selection {
	marked := make([]bool, selection.DocumentCount())
	for _, ordinal := range ordinals {
		marked[ordinal] = true
	}
	return selection.Keeping(func(ordinal uint32) bool {
		return uint64(ordinal) < uint64(len(marked)) && marked[ordinal]
	})
}

func tooLargeForOneFile(cost, budget float64) error {
	return narsilerr.New(narsilerr.CodePersistenceSaveFailed,
		"A document needs up to "+strconv.FormatInt(int64(math.Ceil(cost)), 10)+" bytes of a segment, more than the "+
			strconv.FormatInt(int64(math.Max(0, math.Floor(budget))), 10)+" that one file leaves it",
		map[string]any{"bytes": math.Ceil(cost), "budget": math.Floor(budget), "maximum": envelope.MaxFileBytes})
}

func fixedFileBytes(selections []partition.Selection, schema map[string]string, tombstones []string,
	chargesTokens bool) (float64, error) {
	encodedSchema, err := codec.Marshal(schema, codec.EncodeOptions{})
	if err != nil {
		return 0, err
	}
	encodedTombstones, err := codec.Marshal(tombstones, codec.EncodeOptions{})
	if err != nil {
		return 0, err
	}
	fixed := float64(envelope.HeaderBytes + SegmentFileFramingSlackBytes + len(encodedSchema) + len(encodedTombstones))
	for _, selection := range selections {
		fixed += fixedBytesOf(selection.Source.Frozen, chargesTokens)
	}
	return fixed, nil
}

func splitIntoSegmentFiles(selections []partition.Selection, schema map[string]string,
	tombstones []string) ([]segmentFileGroup, error) {
	tokenBytes := 0
	for _, selection := range selections {
		tokenBytes += tokenTableBytes(&selection.Source.Frozen.Keyword.Segment)
	}
	chargesTokens := float64(tokenBytes) > envelope.MaxFileBytes*segmentTokenTableShareOfFile
	fixed, err := fixedFileBytes(selections, schema, tombstones, chargesTokens)
	if err != nil {
		return nil, err
	}
	budget := envelope.MaxFileBytes - fixed
	var groups []segmentFileGroup
	var current segmentFileGroup
	var currentBytes float64
	flush := func() {
		if current.documentCount > 0 {
			groups = append(groups, current)
		}
		current, currentBytes = segmentFileGroup{}, 0
	}
	for _, selection := range selections {
		kept, err := keptDocumentsOf(selection, chargesTokens)
		if err != nil {
			return nil, err
		}
		var ordinals []uint32
		seal := func() {
			if len(ordinals) > 0 {
				current.selections = append(current.selections, keepingOrdinals(kept.selection, ordinals))
				ordinals = nil
			}
		}
		for _, ordinal := range kept.ordinals {
			cost := kept.costs[ordinal]
			if cost > budget {
				return nil, tooLargeForOneFile(cost, budget)
			}
			if currentBytes+cost > budget {
				seal()
				flush()
			}
			ordinals = append(ordinals, ordinal)
			currentBytes += cost
			current.documentCount++
		}
		seal()
	}
	flush()
	return groups, nil
}

func halvesOf(group segmentFileGroup) ([2]segmentFileGroup, error) {
	sources := make([]segments.Source, len(group.selections))
	for at, selection := range group.selections {
		sources[at] = selection.Source
		sources[at].Segment = at
	}
	split, err := segments.Split(sources)
	if err != nil {
		return [2]segmentFileGroup{}, err
	}
	var halves [2]segmentFileGroup
	for half, kept := range split {
		for _, source := range kept {
			halves[half].selections = append(halves[half].selections, group.selections[source.Segment].Keeping(source.Keep))
		}
		halves[half].documentCount = keptDocumentCount(halves[half].selections)
	}
	return halves, nil
}
