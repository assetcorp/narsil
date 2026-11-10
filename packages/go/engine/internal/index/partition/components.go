package partition

import (
	"sort"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

type componentRecord struct {
	termFrequencies map[string]float64
	fieldLengths    map[string]float64
	idf             map[string]float64
}

func (r *componentRecord) public() *model.ScoreComponents {
	if r == nil {
		return &model.ScoreComponents{TermFrequencies: map[string]float64{}, FieldLengths: map[string]float64{}, IDF: map[string]float64{}}
	}
	return &model.ScoreComponents{TermFrequencies: r.termFrequencies, FieldLengths: r.fieldLengths, IDF: r.idf}
}

func ComputeIDF(documentFrequency, totalDocuments float64) float64 {
	if totalDocuments == 0 {
		return 0
	}
	return core.Ln((totalDocuments-documentFrequency+0.5)/(documentFrequency+0.5) + 1)
}

func ComputeBM25WithIDF(termFrequency, idf, fieldLength, averageFieldLength, k1, b float64) float64 {
	if averageFieldLength == 0 {
		return 0
	}
	numerator := float64(termFrequency * (k1 + 1))
	scaledLength := float64(b*fieldLength) / averageFieldLength
	denominator := termFrequency + float64(k1*(1-b+scaledLength))
	if denominator == 0 {
		return 0
	}
	return float64(idf * (numerator / denominator))
}

type componentContext struct {
	request *core.KeywordRequest
	names   []string
	found   map[uint32]*componentRecord
	wanted  map[uint32]struct{}
}

type listRows struct {
	docIDs      func(row int) uint32
	fields      func(row int) uint16
	frequencies func(row int) float64
	byDocument  map[uint32][]int
	documents   []uint32
}

func holdsBit(bits []uint32, ordinal uint32) bool {
	word := int(ordinal >> 5)
	return word < len(bits) && bits[word]>>(ordinal&31)&1 == 1
}

func (c *componentContext) scorable(ordinal uint32) bool {
	request := c.request
	if !holdsBit(request.Live, ordinal) || holdsBit(request.Removed, ordinal) {
		return false
	}
	return !request.HasFilter || holdsBit(request.Filter, ordinal)
}

func (c *componentContext) rankOf(field uint16) int {
	if int(field) < len(c.request.NameRanks) {
		return int(c.request.NameRanks[field])
	}
	return unknownFieldRank
}

func (c *componentContext) rowsOfList(list int) listRows {
	request := c.request
	flags := request.Lists[list*core.KeywordListStride+core.KeywordListFlags]
	start := int(request.Lists[list*core.KeywordListStride+core.KeywordListStart])
	length := int(request.Lists[list*core.KeywordListStride+core.KeywordListLength])
	rows := listRows{byDocument: map[uint32][]int{}}
	if flags&core.KeywordListFromRows != 0 {
		rows.docIDs = func(row int) uint32 { return request.RowDocIDs[row] }
		rows.fields = func(row int) uint16 { return request.RowFields[row] }
		rows.frequencies = func(row int) float64 { return request.RowFrequencies[row] }
	} else {
		rows.docIDs = func(row int) uint32 { return request.PoolDocIDs[row] }
		rows.fields = func(row int) uint16 { return request.PoolFields[row] }
		rows.frequencies = func(row int) float64 { return float64(request.PoolFrequencies[row]) }
	}
	for row := start; row < start+length; row++ {
		ordinal := rows.docIDs(row)
		if _, wanted := c.wanted[ordinal]; !wanted {
			continue
		}
		if _, seen := rows.byDocument[ordinal]; !seen {
			rows.documents = append(rows.documents, ordinal)
		}
		rows.byDocument[ordinal] = append(rows.byDocument[ordinal], row)
	}
	for _, held := range rows.byDocument {
		sort.SliceStable(held, func(left, right int) bool {
			return c.rankOf(rows.fields(held[left])) < c.rankOf(rows.fields(held[right]))
		})
	}
	return rows
}

func (c *componentContext) lengthIn(field uint16, ordinal uint32) float64 {
	request := c.request
	fieldCount := len(request.Searchable)
	average := request.FieldNumbers[core.KeywordFieldAverageLen*fieldCount+int(field)]
	column := request.Lengths[field]
	stored := uint32(0)
	if int(ordinal) < len(column) {
		stored = column[ordinal]
	}
	if stored > 0 {
		return float64(stored)
	}
	return average
}

func (c *componentContext) rowScore(frequency, idf float64, field uint16, ordinal uint32) float64 {
	numbers := c.request.FieldNumbers
	fieldCount := len(c.request.Searchable)
	bm25 := ComputeBM25WithIDF(frequency, idf, c.lengthIn(field, ordinal),
		numbers[core.KeywordFieldAverageLen*fieldCount+int(field)],
		numbers[core.KeywordFieldK1*fieldCount+int(field)],
		numbers[core.KeywordFieldB*fieldCount+int(field)])
	return float64(bm25 * numbers[core.KeywordFieldBoosts*fieldCount+int(field)])
}

func (c *componentContext) searchable(field uint16) bool {
	return int(field) < len(c.request.Searchable) && c.request.Searchable[field] != 0
}

func (c *componentContext) record(rows listRows, held []int, ordinal uint32, label string, idf float64) {
	for _, row := range held {
		field := rows.fields(row)
		if !c.searchable(field) {
			continue
		}
		record := c.found[ordinal]
		if record == nil {
			record = &componentRecord{termFrequencies: map[string]float64{}, fieldLengths: map[string]float64{}, idf: map[string]float64{}}
			c.found[ordinal] = record
		}
		name := c.names[field]
		record.termFrequencies[name+":"+label] = rows.frequencies(row)
		record.fieldLengths[name] = c.lengthIn(field, ordinal)
		record.idf[label] = idf
	}
}

type groupWinner struct {
	sum  float64
	rows []int
	list int
	from listRows
}

func (c *componentContext) recordGroup(listFrom, listEnd int, idf float64, labels []string) {
	request := c.request
	winners := map[uint32]*groupWinner{}
	var order []uint32
	for list := listFrom; list < listEnd; list++ {
		factor := request.ListValues[list*core.KeywordListValueStride+core.KeywordListFactor]
		partialFactor := request.ListValues[list*core.KeywordListValueStride+core.KeywordListPartialFactor]
		rows := c.rowsOfList(list)
		for _, ordinal := range rows.documents {
			if !c.scorable(ordinal) {
				continue
			}
			sum := 0.0
			var kept []int
			for _, row := range rows.byDocument[ordinal] {
				field := rows.fields(row)
				if !c.searchable(field) {
					continue
				}
				rowFactor := factor
				if request.PartialMarks[field] == 1 {
					rowFactor = partialFactor
				}
				if !(rowFactor > 0) {
					continue
				}
				sum += float64(c.rowScore(rows.frequencies(row), idf, field, ordinal) * rowFactor)
				kept = append(kept, row)
			}
			if len(kept) == 0 {
				continue
			}
			best := winners[ordinal]
			if best == nil {
				order = append(order, ordinal)
			}
			if best == nil || sum > best.sum {
				winners[ordinal] = &groupWinner{sum: sum, rows: kept, list: list, from: rows}
			}
		}
	}
	for _, ordinal := range order {
		winner := winners[ordinal]
		c.record(winner.from, winner.rows, ordinal, labels[winner.list], idf)
	}
}

func keywordComponents(builder *requestBuilder, names []string, ordinals []int32) map[uint32]*componentRecord {
	request := &builder.request
	context := componentContext{request: request, names: names, found: map[uint32]*componentRecord{}, wanted: map[uint32]struct{}{}}
	for _, ordinal := range ordinals {
		context.wanted[uint32(ordinal)] = struct{}{}
	}
	for slot := 0; slot < int(request.SlotCount); slot++ {
		base := slot * core.KeywordSlotStride
		listFrom, valueFrom := 0, 0
		if slot > 0 {
			listFrom = int(request.Slots[base-core.KeywordSlotStride+core.KeywordSlotListEnd])
			valueFrom = int(request.Slots[base-core.KeywordSlotStride+core.KeywordSlotValueEnd])
		}
		listEnd := int(request.Slots[base+core.KeywordSlotListEnd])
		valueEnd := int(request.Slots[base+core.KeywordSlotValueEnd])
		kind := request.Slots[base+core.KeywordSlotKind]
		if kind == core.KeywordGroupSlot {
			context.recordGroup(listFrom, listEnd, ComputeIDF(request.SlotValues[valueFrom], request.TotalDocuments), builder.labels)
			continue
		}
		phraseIDF := 0.0
		if kind == core.KeywordPhraseSlot {
			for value := valueFrom; value < valueEnd; value++ {
				phraseIDF += ComputeIDF(request.SlotValues[value], request.TotalDocuments)
			}
		}
		for list := listFrom; list < listEnd; list++ {
			idf := phraseIDF
			if kind != core.KeywordPhraseSlot {
				idf = ComputeIDF(request.ListValues[list*core.KeywordListValueStride+core.KeywordListDocFrequency], request.TotalDocuments)
			}
			rows := context.rowsOfList(list)
			for _, ordinal := range rows.documents {
				if context.scorable(ordinal) {
					context.record(rows, rows.byDocument[ordinal], ordinal, builder.labels[list], idf)
				}
			}
		}
	}
	return context.found
}
