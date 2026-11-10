package partition

import (
	"sort"
	"sync/atomic"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/postings"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

func (s searcher) combinedPostings(own string, synonyms []string) (postings.List, rowColumns, bool, bool, error) {
	var lists []postings.List
	for _, token := range append([]string{own}, synonyms...) {
		list, found, err := s.src.lookup(token)
		if err != nil {
			return postings.List{}, rowColumns{}, false, false, err
		}
		if found {
			lists = append(lists, list)
		}
	}
	if len(lists) == 0 {
		return postings.List{}, rowColumns{}, false, false, nil
	}
	if len(lists) == 1 {
		return lists[0], rowColumns{}, true, true, nil
	}
	allOrdered := true
	for _, list := range lists {
		allOrdered = allOrdered && list.Ordered
	}
	if allOrdered {
		return postings.List{}, s.mergeOrderedLists(lists), false, true, nil
	}
	return postings.List{}, s.combineUnorderedLists(lists), false, true, nil
}

type fieldRow struct {
	field uint16
	row   int
}

func (s searcher) mergeOrderedLists(lists []postings.List) rowColumns {
	var combined rowColumns
	cursors := make([]int, len(lists))
	var run []fieldRow
	for {
		lowest, found := uint32(0), false
		for at, list := range lists {
			if cursors[at] < list.Length() && (!found || list.DocIDs[cursors[at]] < lowest) {
				lowest, found = list.DocIDs[cursors[at]], true
			}
		}
		if !found {
			return combined
		}
		run = run[:0]
		deleted := s.src.isRemoved(lowest)
		for at, list := range lists {
			row := cursors[at]
			for ; row < list.Length() && list.DocIDs[row] == lowest; row++ {
				if deleted {
					continue
				}
				combined.add(&run, lowest, list.Fields[row], float64(list.Frequencies[row]))
			}
			cursors[at] = row
		}
	}
}

func (c *rowColumns) add(run *[]fieldRow, ordinal uint32, field uint16, frequency float64) {
	for _, held := range *run {
		if held.field == field {
			c.frequencies[held.row] += frequency
			return
		}
	}
	*run = append(*run, fieldRow{field: field, row: len(c.docIDs)})
	c.docIDs = append(c.docIDs, ordinal)
	c.fields = append(c.fields, field)
	c.frequencies = append(c.frequencies, frequency)
}

func (s searcher) combineUnorderedLists(lists []postings.List) rowColumns {
	var combined rowColumns
	rowOf := map[uint64]int{}
	for _, list := range lists {
		for row := 0; row < list.Length(); row++ {
			ordinal := list.DocIDs[row]
			if list.DeadDocuments > 0 && s.src.isRemoved(ordinal) {
				continue
			}
			field := list.Fields[row]
			frequency := float64(list.Frequencies[row])
			key := uint64(ordinal)<<16 | uint64(field)
			if existing, found := rowOf[key]; found {
				combined.frequencies[existing] += frequency
				continue
			}
			rowOf[key] = len(combined.docIDs)
			combined.docIDs = append(combined.docIDs, ordinal)
			combined.fields = append(combined.fields, field)
			combined.frequencies = append(combined.frequencies, frequency)
		}
	}
	order := make([]int, len(combined.docIDs))
	for index := range order {
		order[index] = index
	}
	sort.SliceStable(order, func(left, right int) bool { return combined.docIDs[order[left]] < combined.docIDs[order[right]] })
	sorted := rowColumns{docIDs: make([]uint32, len(order)), fields: make([]uint16, len(order)), frequencies: make([]float64, len(order))}
	for at, row := range order {
		sorted.docIDs[at] = combined.docIDs[row]
		sorted.fields[at] = combined.fields[row]
		sorted.frequencies[at] = combined.frequencies[row]
	}
	return sorted
}

type WorkMeter struct {
	cap   int64
	spent atomic.Int64
}

func NewWorkMeter(cap int64) *WorkMeter {
	return &WorkMeter{cap: cap}
}

func (m *WorkMeter) Add(units int64) error {
	if m == nil || units <= 0 {
		return nil
	}
	if m.spent.Add(units) > m.cap {
		return narsilerr.New(narsilerr.CodeSearchWorkCapExceeded,
			"The engine stopped this search before it checked every candidate, because the work on its pattern tests and phrases passed the cap of "+
				text.FormatNumber(float64(m.cap))+" units. Narrow the tests or the phrases, or raise the patternWorkCap engine setting",
			map[string]any{"cap": m.cap})
	}
	return nil
}

func (m *WorkMeter) Remaining() int64 {
	if m == nil {
		return 0
	}
	return m.cap - m.spent.Load()
}
