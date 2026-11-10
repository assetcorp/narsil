package query

import (
	"math"
	"sort"
)

const noRow = -1

func removedAt(removed []uint32, ordinal uint32) bool {
	word := int(ordinal >> 5)
	return word < len(removed) && removed[word]&(1<<(ordinal&31)) != 0
}

func (s *searcher) combine(segment *Segment, lists []postingList) *rowColumns {
	rows := &s.combined
	rows.documents, rows.frequencies, rows.fields = rows.documents[:0], rows.frequencies[:0], rows.fields[:0]
	ordered := true
	for _, list := range lists {
		ordered = ordered && list.ordered
	}
	if ordered {
		s.mergeOrdered(segment, lists, rows)
		return rows
	}
	s.combineUnordered(segment, lists, rows)
	return rows
}

func (s *searcher) addRow(rows *rowColumns, document uint32, field uint16, frequency float64) {
	if existing := s.rowOfField[field]; existing != noRow {
		rows.frequencies[existing] += frequency
		return
	}
	s.rowOfField[field] = int32(len(rows.documents))
	rows.documents = append(rows.documents, document)
	rows.fields = append(rows.fields, field)
	rows.frequencies = append(rows.frequencies, frequency)
}

func (s *searcher) mergeOrdered(segment *Segment, lists []postingList, rows *rowColumns) {
	if s.rowOfField == nil {
		s.rowOfField = make([]int32, fieldSlots)
		for at := range s.rowOfField {
			s.rowOfField[at] = noRow
		}
	}
	documents, frequencies, fields := s.poolOf(segment)
	removed := segment.removed()
	cursors := make([]uint32, len(lists))
	lowest := func() uint64 {
		least := uint64(math.MaxUint64)
		for at, list := range lists {
			if cursors[at] < list.length {
				least = min(least, uint64(documents[list.start+cursors[at]]))
			}
		}
		return least
	}
	for next := lowest(); next != math.MaxUint64; next = lowest() {
		document := uint32(next)
		runStart := len(rows.documents)
		deleted := removedAt(removed, document)
		for at, list := range lists {
			row := cursors[at]
			for ; row < list.length && documents[list.start+row] == document; row++ {
				if !deleted {
					s.addRow(rows, document, fields[list.start+row], float64(frequencies[list.start+row]))
				}
			}
			cursors[at] = row
		}
		for row := runStart; row < len(rows.documents); row++ {
			s.rowOfField[rows.fields[row]] = noRow
		}
	}
}

func (s *searcher) combineUnordered(segment *Segment, lists []postingList, rows *rowColumns) {
	documents, frequencies, fields := s.poolOf(segment)
	removed := segment.removed()
	rowOf := map[uint64]int{}
	for _, list := range lists {
		for row := list.start; row < list.start+list.length; row++ {
			document := documents[row]
			if removedAt(removed, document) {
				continue
			}
			field := fields[row]
			key := uint64(document)*fieldSlots + uint64(field)
			if existing, found := rowOf[key]; found {
				rows.frequencies[existing] += float64(frequencies[row])
				continue
			}
			rowOf[key] = len(rows.documents)
			rows.documents = append(rows.documents, document)
			rows.fields = append(rows.fields, field)
			rows.frequencies = append(rows.frequencies, float64(frequencies[row]))
		}
	}
	order := make([]int, len(rows.documents))
	for at := range order {
		order[at] = at
	}
	sort.SliceStable(order, func(left, right int) bool {
		return rows.documents[order[left]] < rows.documents[order[right]]
	})
	sorted := rowColumns{
		documents:   make([]uint32, len(order)),
		frequencies: make([]float64, len(order)),
		fields:      make([]uint16, len(order)),
	}
	for at, row := range order {
		sorted.documents[at] = rows.documents[row]
		sorted.frequencies[at] = rows.frequencies[row]
		sorted.fields[at] = rows.fields[row]
	}
	*rows = sorted
}
