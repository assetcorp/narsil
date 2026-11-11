package query

import (
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

const unknownFieldRank = 0x10000

func inverseDocumentFrequency(documentFrequency, totalDocuments float64) float64 {
	if totalDocuments == 0 {
		return 0
	}
	return core.Ln((totalDocuments-documentFrequency+0.5)/(documentFrequency+0.5) + 1)
}

func bm25WithIDF(termFrequency, idf, fieldLength, averageFieldLength, k1, b float64) float64 {
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

type componentRows struct {
	fromRows   bool
	byDocument map[uint32][]int
	documents  []uint32
}

type componentScan struct {
	request *core.KeywordRequest
	names   []string
	labels  []string
	wanted  map[uint32]struct{}
	found   map[uint32]*model.ScoreComponents
}

func bitHeld(bits []uint32, ordinal uint32) bool {
	word := int(ordinal >> 5)
	return word < len(bits) && bits[word]>>(ordinal&31)&1 == 1
}

func (c *componentScan) scorable(ordinal uint32) bool {
	request := c.request
	if !bitHeld(request.Live, ordinal) || bitHeld(request.Removed, ordinal) {
		return false
	}
	return !request.HasFilter || bitHeld(request.Filter, ordinal)
}

func (c *componentScan) rankOf(field uint16) int {
	if int(field) < len(c.request.NameRanks) {
		return int(c.request.NameRanks[field])
	}
	return unknownFieldRank
}

func (c *componentScan) document(rows *componentRows, row int) uint32 {
	if rows.fromRows {
		return c.request.RowDocIDs[row]
	}
	return c.request.PoolDocIDs[row]
}

func (c *componentScan) field(rows *componentRows, row int) uint16 {
	if rows.fromRows {
		return c.request.RowFields[row]
	}
	return c.request.PoolFields[row]
}

func (c *componentScan) frequency(rows *componentRows, row int) float64 {
	if rows.fromRows {
		return c.request.RowFrequencies[row]
	}
	return float64(c.request.PoolFrequencies[row])
}

func (c *componentScan) rowsOf(list int) *componentRows {
	request := c.request
	flags := request.Lists[list*core.KeywordListStride+core.KeywordListFlags]
	start := int(request.Lists[list*core.KeywordListStride+core.KeywordListStart])
	length := int(request.Lists[list*core.KeywordListStride+core.KeywordListLength])
	rows := &componentRows{fromRows: flags&core.KeywordListFromRows != 0, byDocument: map[uint32][]int{}}
	for row := start; row < start+length; row++ {
		ordinal := c.document(rows, row)
		if _, wanted := c.wanted[ordinal]; !wanted {
			continue
		}
		if _, seen := rows.byDocument[ordinal]; !seen {
			rows.documents = append(rows.documents, ordinal)
		}
		rows.byDocument[ordinal] = append(rows.byDocument[ordinal], row)
	}
	for _, held := range rows.byDocument {
		slices.SortStableFunc(held, func(left, right int) int {
			return c.rankOf(c.field(rows, left)) - c.rankOf(c.field(rows, right))
		})
	}
	return rows
}

func (c *componentScan) lengthIn(field uint16, ordinal uint32) float64 {
	request := c.request
	average := request.FieldNumbers[core.KeywordFieldAverageLen*len(request.Searchable)+int(field)]
	if int(field) < len(request.Lengths) {
		if column := request.Lengths[field]; int(ordinal) < len(column) && column[ordinal] > 0 {
			return float64(column[ordinal])
		}
	}
	return average
}

func (c *componentScan) rowScore(frequency, idf float64, field uint16, ordinal uint32) float64 {
	numbers := c.request.FieldNumbers
	count := len(c.request.Searchable)
	at := int(field)
	bm25 := bm25WithIDF(frequency, idf, c.lengthIn(field, ordinal), numbers[core.KeywordFieldAverageLen*count+at],
		numbers[core.KeywordFieldK1*count+at], numbers[core.KeywordFieldB*count+at])
	return float64(bm25 * numbers[core.KeywordFieldBoosts*count+at])
}

func (c *componentScan) searchable(field uint16) bool {
	return int(field) < len(c.request.Searchable) && c.request.Searchable[field] != 0
}

func (c *componentScan) record(rows *componentRows, held []int, ordinal uint32, label string, idf float64) {
	for _, row := range held {
		field := c.field(rows, row)
		if !c.searchable(field) {
			continue
		}
		found := c.found[ordinal]
		if found == nil {
			found = &model.ScoreComponents{TermFrequencies: map[string]float64{}, FieldLengths: map[string]float64{}, IDF: map[string]float64{}}
			c.found[ordinal] = found
		}
		name := c.names[field]
		found.TermFrequencies[name+":"+label] = c.frequency(rows, row)
		found.FieldLengths[name] = c.lengthIn(field, ordinal)
		found.IDF[label] = idf
	}
}

type groupWinner struct {
	sum  float64
	rows []int
	list int
	from *componentRows
}

func (c *componentScan) recordGroup(listFrom, listEnd int, idf float64) {
	request := c.request
	winners := map[uint32]*groupWinner{}
	var order []uint32
	for list := listFrom; list < listEnd; list++ {
		factor := request.ListValues[list*core.KeywordListValueStride+core.KeywordListFactor]
		partialFactor := request.ListValues[list*core.KeywordListValueStride+core.KeywordListPartialFactor]
		rows := c.rowsOf(list)
		for _, ordinal := range rows.documents {
			if !c.scorable(ordinal) {
				continue
			}
			sum := 0.0
			var kept []int
			for _, row := range rows.byDocument[ordinal] {
				field := c.field(rows, row)
				if !c.searchable(field) {
					continue
				}
				rowFactor := factor
				if int(field) < len(request.PartialMarks) && request.PartialMarks[field] == 1 {
					rowFactor = partialFactor
				}
				if !(rowFactor > 0) {
					continue
				}
				sum += float64(c.rowScore(c.frequency(rows, row), idf, field, ordinal) * rowFactor)
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
		c.record(winner.from, winner.rows, ordinal, c.labels[winner.list], idf)
	}
}

func keywordComponents(builder *requestBuilder, names []string, ordinals []int32) map[uint32]*model.ScoreComponents {
	request := &builder.request
	scan := componentScan{request: request, names: names, labels: builder.labels, wanted: make(map[uint32]struct{}, len(ordinals)),
		found: map[uint32]*model.ScoreComponents{}}
	for _, ordinal := range ordinals {
		scan.wanted[uint32(ordinal)] = struct{}{}
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
			scan.recordGroup(listFrom, listEnd, inverseDocumentFrequency(request.SlotValues[valueFrom], request.TotalDocuments))
			continue
		}
		phraseIDF := 0.0
		if kind == core.KeywordPhraseSlot {
			for value := valueFrom; value < valueEnd; value++ {
				phraseIDF += inverseDocumentFrequency(request.SlotValues[value], request.TotalDocuments)
			}
		}
		for list := listFrom; list < listEnd; list++ {
			idf := phraseIDF
			if kind != core.KeywordPhraseSlot {
				idf = inverseDocumentFrequency(request.ListValues[list*core.KeywordListValueStride+core.KeywordListDocFrequency], request.TotalDocuments)
			}
			rows := scan.rowsOf(list)
			for _, ordinal := range rows.documents {
				if scan.scorable(ordinal) {
					scan.record(rows, rows.byDocument[ordinal], ordinal, scan.labels[list], idf)
				}
			}
		}
	}
	return scan.found
}
