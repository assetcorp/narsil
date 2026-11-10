package geo

import (
	"cmp"
	"math"
	"slices"
)

type locationRow struct {
	code    uint64
	lat     float64
	lon     float64
	ordinal uint32
	removed bool
}

type rowPlace struct {
	pending  bool
	code     uint64
	position int
}

type Entry struct {
	Ordinal uint32
	Lat     float64
	Lon     float64
}

type Index struct {
	located        []locationRow
	locatedRemoved int
	pending        []locationRow
	pendingRemoved int
	byOrdinal      map[uint32]rowPlace
}

func NewIndex() *Index {
	return &Index{byOrdinal: map[uint32]rowPlace{}}
}

func compareRows(left, right locationRow) int {
	if order := cmp.Compare(left.code, right.code); order != 0 {
		return order
	}
	return cmp.Compare(left.ordinal, right.ordinal)
}

func firstAtOrAfter(rows []locationRow, code uint64) int {
	at, _ := slices.BinarySearchFunc(rows, code, func(row locationRow, target uint64) int {
		return cmp.Compare(row.code, target)
	})
	return at
}

func locatedRowOf(rows []locationRow, code uint64, ordinal uint32) (int, bool) {
	return slices.BinarySearchFunc(rows, locationRow{code: code, ordinal: ordinal}, compareRows)
}

func (index *Index) Insert(ordinal uint32, lat, lon float64) {
	if place, held := index.byOrdinal[ordinal]; held {
		index.removeDocument(ordinal, place)
	}
	index.pending = append(index.pending, locationRow{code: locationCode(lat, lon), lat: lat, lon: lon, ordinal: ordinal})
	index.byOrdinal[ordinal] = rowPlace{pending: true, position: len(index.pending) - 1}
}

func (index *Index) Remove(ordinal uint32) {
	if place, held := index.byOrdinal[ordinal]; held {
		index.removeDocument(ordinal, place)
	}
}

func (index *Index) removeDocument(ordinal uint32, place rowPlace) {
	delete(index.byOrdinal, ordinal)
	if place.pending {
		index.pending[place.position].removed = true
		index.pendingRemoved++
	} else if at, found := locatedRowOf(index.located, place.code, ordinal); found {
		index.located[at].removed = true
		index.locatedRemoved++
	}
	removedCount := float64(index.locatedRemoved + index.pendingRemoved)
	held := float64(len(index.located) + len(index.pending))
	if removedCount >= math.Max(pendingRemovalMergeFloor, held/pendingRemovalMergeDivisor) {
		index.Settle()
	}
}

func withoutRemoved(rows []locationRow) []locationRow {
	return slices.DeleteFunc(rows, func(row locationRow) bool { return row.removed })
}

func (index *Index) Settle() {
	if index.locatedRemoved > 0 {
		index.located = withoutRemoved(index.located)
		index.locatedRemoved = 0
	}
	if index.pendingRemoved > 0 {
		index.pending = withoutRemoved(index.pending)
		index.pendingRemoved = 0
	}
	if len(index.pending) == 0 {
		index.pending = nil
		return
	}
	slices.SortFunc(index.pending, compareRows)
	placed := len(index.located)
	index.located = slices.Grow(index.located, len(index.pending))[:placed+len(index.pending)]
	unmerged := placed
	for right := len(index.pending) - 1; right >= 0; right-- {
		row := index.pending[right]
		from, _ := slices.BinarySearchFunc(index.located[:unmerged], row, func(candidate, target locationRow) int {
			if compareRows(candidate, target) > 0 {
				return 1
			}
			return -1
		})
		copy(index.located[from+right+1:], index.located[from:unmerged])
		index.located[from+right] = row
		index.byOrdinal[row.ordinal] = rowPlace{code: row.code}
		unmerged = from
	}
	index.pending = nil
}

func (index *Index) Clear() {
	index.located = nil
	index.locatedRemoved = 0
	index.pending = nil
	index.pendingRemoved = 0
	clear(index.byOrdinal)
}

func (index *Index) Count() int {
	return len(index.byOrdinal)
}

func (index *Index) forEachLiveRow(visit func(row *locationRow)) {
	for at := range index.located {
		if !index.located[at].removed {
			visit(&index.located[at])
		}
	}
	for at := range index.pending {
		if !index.pending[at].removed {
			visit(&index.pending[at])
		}
	}
}

func (index *Index) ForEachDocument(visit func(ordinal uint32)) {
	index.forEachLiveRow(func(row *locationRow) { visit(row.ordinal) })
}

func (index *Index) Entries() []Entry {
	rows := make([]locationRow, 0, len(index.byOrdinal))
	index.forEachLiveRow(func(row *locationRow) { rows = append(rows, *row) })
	if len(index.pending) > 0 {
		slices.SortFunc(rows, compareRows)
	}
	entries := make([]Entry, len(rows))
	for at, row := range rows {
		entries[at] = Entry{Ordinal: row.ordinal, Lat: row.lat, Lon: row.lon}
	}
	return entries
}
