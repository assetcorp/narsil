package query

import (
	"slices"
	"sort"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type fieldScoring struct {
	names        []string
	rankedNames  []string
	ranks        []uint16
	searchable   []uint8
	partialMarks []uint8
	numbers      []float64
	zeros        []uint32
}

func (f *fieldScoring) rank(names []string) {
	if slices.Equal(f.rankedNames, names) && len(f.ranks) == len(names) {
		return
	}
	order := make([]int, len(names))
	for at := range order {
		order[at] = at
	}
	sort.SliceStable(order, func(left, right int) bool {
		return text.CompareCodePoints(names[order[left]], names[order[right]]) < 0
	})
	f.ranks = slices.Grow(f.ranks[:0], len(names))[:len(names)]
	for rank, field := range order {
		f.ranks[field] = uint16(rank)
	}
	f.rankedNames = append(f.rankedNames[:0], names...)
}

func (f *fieldScoring) load(names []string, query *KeywordQuery, averages []float64) {
	count := len(names)
	f.names = names
	f.rank(names)
	f.searchable = slices.Grow(f.searchable[:0], count)[:count]
	f.partialMarks = slices.Grow(f.partialMarks[:0], count)[:count]
	f.numbers = slices.Grow(f.numbers[:0], count*core.KeywordFieldNumberCols)[:count*core.KeywordFieldNumberCols]
	k1, b := DefaultBM25K1, DefaultBM25B
	var perField map[string]FieldBM25
	if query.BM25 != nil {
		k1, b, perField = query.BM25.K1, query.BM25.B, query.BM25.PerField
	}
	for field, name := range names {
		f.searchable[field] = flag(query.Fields == nil || slices.Contains(query.Fields, name))
		f.partialMarks[field] = flag(slices.Contains(query.PartialFields, name))
		boost := 1.0
		if value, found := query.Boost[name]; found {
			boost = value
		}
		f.numbers[core.KeywordFieldBoosts*count+field] = boost
		f.numbers[core.KeywordFieldAverageLen*count+field] = averages[field]
		fieldK1, fieldB := k1, b
		if pair, found := perField[name]; found {
			fieldK1, fieldB = pair.K1, pair.B
		}
		f.numbers[core.KeywordFieldK1*count+field] = fieldK1
		f.numbers[core.KeywordFieldB*count+field] = fieldB
	}
}

func (f *fieldScoring) apply(request *core.KeywordRequest, segment *Segment) {
	request.Searchable = append(request.Searchable, f.searchable...)
	request.PartialMarks = append(request.PartialMarks, f.partialMarks...)
	request.NameRanks = append(request.NameRanks, f.ranks...)
	request.FieldNumbers = append(request.FieldNumbers, f.numbers...)
	if prefix := segment.fieldPrefix(); prefix < len(f.names) && len(f.zeros) < int(segment.capacity()) {
		f.zeros = make([]uint32, segment.capacity())
	}
	for field := range f.names {
		request.Lengths = append(request.Lengths, segment.lengthColumn(field, f.zeros))
	}
}

func flag(set bool) uint8 {
	if set {
		return 1
	}
	return 0
}
