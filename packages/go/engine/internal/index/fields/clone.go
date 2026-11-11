package fields

import (
	"maps"
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
)

type cloning struct {
	err error
}

func cloneArray[T core.RegionElement](c *cloning, to, from *array[T]) {
	*to = array[T]{name: from.name, maxCount: from.maxCount}
	if c.err != nil || from.capacity == 0 {
		return
	}
	if c.err = to.reserveExactly(from.capacity); c.err == nil {
		copy(to.all(), from.all())
	}
}

func clonePresence(c *cloning, to, from *presence) {
	cloneArray(c, &to.bits, &from.bits)
	to.words, to.stale = from.words, from.stale
}

func (b *Boolean) clone() (*Boolean, error) {
	copied := &Boolean{limits: b.limits, trueCount: b.trueCount, falseCount: b.falseCount}
	c := &cloning{}
	cloneArray(c, &copied.trueBits, &b.trueBits)
	cloneArray(c, &copied.falseBits, &b.falseBits)
	clonePresence(c, &copied.present, &b.present)
	return settledClone(copied, c, copied.Release)
}

func (n *Numeric) clone() (*Numeric, error) {
	copied := &Numeric{limits: n.limits, length: n.length,
		pendingValues: slices.Clone(n.pendingValues), pendingOrdinals: slices.Clone(n.pendingOrdinals),
		removedOrdinals: slices.Clone(n.removedOrdinals), removedValues: slices.Clone(n.removedValues),
		removedLimits: slices.Clone(n.removedLimits)}
	c := &cloning{}
	cloneArray(c, &copied.values, &n.values)
	cloneArray(c, &copied.ordinals, &n.ordinals)
	clonePresence(c, &copied.present, &n.present)
	return settledClone(copied, c, copied.Release)
}

func (s *orderedSet) clone() *orderedSet {
	return &orderedSet{members: slices.Clone(s.members), alive: slices.Clone(s.alive), position: maps.Clone(s.position)}
}

func (e *Enum) clone() (*Enum, error) {
	copied := &Enum{limits: e.limits, values: make(map[string]*enumValue, len(e.values)), unitCount: e.unitCount,
		postingCount: e.postingCount, built: slices.Clone(e.built), dirty: e.dirty}
	for key, value := range e.values {
		copied.values[key] = &enumValue{text: value.text, units: slices.Clone(value.units), ordinals: value.ordinals.clone()}
	}
	c := &cloning{}
	cloneArray(c, &copied.units, &e.units)
	cloneArray(c, &copied.offsets, &e.offsets)
	cloneArray(c, &copied.postingOffsets, &e.postingOffsets)
	cloneArray(c, &copied.postings, &e.postings)
	cloneArray(c, &copied.suffixOrder, &e.suffixOrder)
	clonePresence(c, &copied.present, &e.present)
	return settledClone(copied, c, copied.Release)
}

func (g *Geo) clone() (*Geo, error) {
	copied := &Geo{limits: g.limits, placed: g.placed, removedRows: slices.Clone(g.removedRows),
		pending: slices.Clone(g.pending), pendingRemoved: maps.Clone(g.pendingRemoved), byDocument: maps.Clone(g.byDocument)}
	c := &cloning{}
	cloneArray(c, &copied.codes, &g.codes)
	cloneArray(c, &copied.lat, &g.lat)
	cloneArray(c, &copied.lon, &g.lon)
	cloneArray(c, &copied.ordinals, &g.ordinals)
	clonePresence(c, &copied.present, &g.present)
	return settledClone(copied, c, copied.Release)
}

func (p *Pattern) clone() (*Pattern, error) {
	copied := &Pattern{limits: p.limits, runs: make(map[runKey]*runList, len(p.runs)), documents: slices.Clone(p.documents),
		documentSize: p.documentSize, postingTotal: p.postingTotal, folded: slices.Clone(p.folded),
		keys: maps.Clone(p.keys), built: p.built, dirty: p.dirty}
	for key, list := range p.runs {
		copied.runs[key] = &runList{ids: slices.Clone(list.ids), removed: maps.Clone(list.removed), ordered: list.ordered}
	}
	c := &cloning{}
	cloneArray(c, &copied.docIDs, &p.docIDs)
	cloneArray(c, &copied.runCodes, &p.runCodes)
	cloneArray(c, &copied.offsets, &p.offsets)
	cloneArray(c, &copied.postings, &p.postings)
	return settledClone(copied, c, copied.Release)
}

func (s *Stored) clone() (*Stored, error) {
	copied := &Stored{path: s.path, limits: s.limits, ordinals: s.ordinals, elements: s.elements, usedUnits: s.usedUnits,
		usedBytes: s.usedBytes, liveUnits: s.liveUnits, liveBytes: s.liveBytes}
	c := &cloning{}
	cloneArray(c, &copied.shapes, &s.shapes)
	cloneArray(c, &copied.starts, &s.starts)
	cloneArray(c, &copied.kinds, &s.kinds)
	cloneArray(c, &copied.numbers, &s.numbers)
	cloneArray(c, &copied.textStart, &s.textStart)
	cloneArray(c, &copied.textLength, &s.textLength)
	cloneArray(c, &copied.units, &s.units)
	cloneArray(c, &copied.encoded, &s.encoded)
	return settledClone(copied, c, copied.Release)
}

func cloneSortStore(c *cloning, to, from *sortStore) {
	to.limits, to.usedUnits, to.liveUnits = from.limits, from.usedUnits, from.liveUnits
	cloneArray(c, &to.kinds, &from.kinds)
	cloneArray(c, &to.numbers, &from.numbers)
	cloneArray(c, &to.textStart, &from.textStart)
	cloneArray(c, &to.textLength, &from.textLength)
	cloneArray(c, &to.units, &from.units)
}

func (col *SortColumn) clone(stored StoredSource) (*SortColumn, error) {
	copied := &SortColumn{field: col.field, mode: col.mode, stored: stored, valueCount: col.valueCount,
		dictUnitCount: col.dictUnitCount, rankCount: col.rankCount, orderedCount: col.orderedCount,
		dirtyWords: col.dirtyWords, capacity: col.capacity, dirty: maps.Clone(col.dirty)}
	c := &cloning{}
	cloneSortStore(c, &copied.store, &col.store)
	cloneArray(c, &copied.dictKinds, &col.dictKinds)
	cloneArray(c, &copied.dictNumbers, &col.dictNumbers)
	cloneArray(c, &copied.dictTextStart, &col.dictTextStart)
	cloneArray(c, &copied.dictTextLength, &col.dictTextLength)
	cloneArray(c, &copied.dictUnits, &col.dictUnits)
	cloneArray(c, &copied.ranks, &col.ranks)
	cloneArray(c, &copied.ordered, &col.ordered)
	cloneArray(c, &copied.dirtyBits, &col.dirtyBits)
	return settledClone(copied, c, copied.Release)
}

func (s *SortColumns) clone(stored map[string]*Stored) (*SortColumns, error) {
	copied := &SortColumns{limits: s.limits, columns: make(map[string]*SortColumn, len(s.columns)),
		keys: make([]string, 0, len(s.keys)), liveCount: s.liveCount}
	c := &cloning{}
	cloneArray(c, &copied.live, &s.live)
	for _, key := range s.keys {
		if c.err != nil {
			break
		}
		column := s.columns[key]
		source := column.stored
		if held, inSet := stored[column.field]; inSet {
			if _, storedInSet := source.(*Stored); storedInSet {
				source = held
			}
		}
		var cloned *SortColumn
		if cloned, c.err = column.clone(source); c.err == nil {
			copied.columns[key] = cloned
			copied.keys = append(copied.keys, key)
		}
	}
	return settledClone(copied, c, copied.Release)
}

func settledClone[T any](copied T, c *cloning, release func()) (T, error) {
	if c.err != nil {
		release()
		var none T
		return none, c.err
	}
	return copied, nil
}

func cloneIndexes[T any](c *cloning, to, from map[string]T, clone func(T) (T, error)) {
	for path, index := range from {
		if c.err != nil {
			return
		}
		var cloned T
		if cloned, c.err = clone(index); c.err == nil {
			to[path] = cloned
		}
	}
}

func (s *Set) Clone() (*Set, error) {
	copied, err := NewSet(s.fields, s.limits)
	if err != nil {
		return nil, err
	}
	copied.storedOrder = slices.Clone(s.storedOrder)
	c := &cloning{}
	cloneIndexes(c, copied.numeric, s.numeric, (*Numeric).clone)
	cloneIndexes(c, copied.booleans, s.booleans, (*Boolean).clone)
	cloneIndexes(c, copied.enums, s.enums, (*Enum).clone)
	cloneIndexes(c, copied.geos, s.geos, (*Geo).clone)
	cloneIndexes(c, copied.sizes, s.sizes, (*Numeric).clone)
	cloneIndexes(c, copied.patterns, s.patterns, (*Pattern).clone)
	cloneIndexes(c, copied.stored, s.stored, (*Stored).clone)
	if c.err == nil && s.sorts != nil {
		copied.sorts, c.err = s.sorts.clone(copied.stored)
	}
	return settledClone(copied, c, copied.Release)
}
