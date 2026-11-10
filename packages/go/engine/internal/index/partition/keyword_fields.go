package partition

import (
	"sort"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

func (s searcher) averageLengthsFor(params *SearchParams) func(field string) (float64, bool) {
	if params.GlobalStats != nil {
		averages := params.GlobalStats.AverageFieldLengths
		return func(field string) (float64, bool) {
			average, found := averages[field]
			return average, found
		}
	}
	return s.src.averageLength
}

func (s searcher) totalDocumentsFor(params *SearchParams) float64 {
	if params.GlobalStats != nil {
		return params.GlobalStats.TotalDocuments
	}
	return float64(s.src.documentCount())
}

func bm25Defaults(params *model.BM25Params) (float64, float64) {
	if params == nil {
		return defaultBM25K1, defaultBM25B
	}
	return params.K1.Or(defaultBM25K1), params.B.Or(defaultBM25B)
}

func (s searcher) loadKeywordFields(builder *requestBuilder, params *SearchParams) {
	request := &builder.request
	names := s.src.names()
	fieldCount := len(names)
	order := make([]int, fieldCount)
	for index := range order {
		order[index] = index
	}
	sort.SliceStable(order, func(left, right int) bool {
		return text.CompareCodePoints(names[order[left]], names[order[right]]) < 0
	})
	request.NameRanks = grownUint16(request.NameRanks, fieldCount)
	for rank, field := range order {
		request.NameRanks[field] = uint16(rank)
	}
	request.Searchable = grownUint8(request.Searchable, fieldCount)
	request.PartialMarks = grownUint8(request.PartialMarks, fieldCount)
	request.FieldNumbers = grownFloat64(request.FieldNumbers, fieldCount*core.KeywordFieldNumberCols)
	request.Lengths = request.Lengths[:0]
	k1, b := bm25Defaults(params.BM25)
	averageOf := s.averageLengthsFor(params)
	numbers := request.FieldNumbers
	for field, name := range names {
		request.Searchable[field] = 0
		if !params.HasFields || containsString(params.Fields, name) {
			request.Searchable[field] = 1
		}
		request.PartialMarks[field] = 0
		if containsString(params.PartialFields, name) {
			request.PartialMarks[field] = 1
		}
		boost, boosted := params.Boost[name]
		if !boosted {
			boost = 1
		}
		numbers[core.KeywordFieldBoosts*fieldCount+field] = boost
		average, found := averageOf(name)
		if !found {
			average = 1
		}
		numbers[core.KeywordFieldAverageLen*fieldCount+field] = average
		fieldK1, fieldB := k1, b
		if params.BM25 != nil {
			if pair, held := params.BM25.Fields[name]; held {
				fieldK1, fieldB = pair.K1.Or(k1), pair.B.Or(b)
			}
		}
		numbers[core.KeywordFieldK1*fieldCount+field] = fieldK1
		numbers[core.KeywordFieldB*fieldCount+field] = fieldB
		request.Lengths = append(request.Lengths, s.src.lengthColumn(name))
	}
}

func grownUint8(values []uint8, length int) []uint8 {
	if cap(values) < length {
		return make([]uint8, length)
	}
	return values[:length]
}

func grownUint16(values []uint16, length int) []uint16 {
	if cap(values) < length {
		return make([]uint16, length)
	}
	return values[:length]
}

func grownFloat64(values []float64, length int) []float64 {
	if cap(values) < length {
		return make([]float64, length)
	}
	return values[:length]
}
