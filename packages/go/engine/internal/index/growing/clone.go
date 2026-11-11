package growing

import (
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
)

type cloning struct {
	err error
}

func cloneColumn[T core.RegionElement](c *cloning, to, from *column[T]) {
	*to = column[T]{}
	if c.err != nil || from.region == nil {
		return
	}
	if c.err = to.resize(from.len()); c.err == nil {
		copy(to.values, from.values)
	}
}

func (t *stringTable) clone(c *cloning) *stringTable {
	copied := &stringTable{header: slices.Clone(t.header), heads: slices.Clone(t.heads), occupied: t.occupied,
		accounted: t.accounted}
	cloneColumn(c, &copied.slots, &t.slots)
	cloneColumn(c, &copied.offset, &t.offset)
	cloneColumn(c, &copied.length, &t.length)
	cloneColumn(c, &copied.next, &t.next)
	cloneColumn(c, &copied.units, &t.units)
	return copied
}

func (t *termColumns) clone(c *cloning) *termColumns {
	copied := &termColumns{ids: t.ids.clone(c), generation: t.generation}
	for _, pair := range [][2]*column[uint32]{{&copied.sliceStart, &t.sliceStart}, {&copied.lengths, &t.lengths},
		{&copied.docFrequency, &t.docFrequency}, {&copied.deadDocuments, &t.deadDocuments}, {&copied.revision, &t.revision}} {
		cloneColumn(c, pair[0], pair[1])
	}
	cloneColumn(c, &copied.sliceClass, &t.sliceClass)
	cloneColumn(c, &copied.flags, &t.flags)
	cloneColumn(c, &copied.totalTermFrequency, &t.totalTermFrequency)
	cloneColumn(c, &copied.surfaceOccurrences, &t.surfaceOccurrences)
	return copied
}

func (p *postingPool) clone(c *cloning) *postingPool {
	copied := &postingPool{tracking: p.tracking, allocation: slices.Clone(p.allocation), freeHeads: slices.Clone(p.freeHeads)}
	cloneColumn(c, &copied.docIDs, &p.docIDs)
	cloneColumn(c, &copied.frequencies, &p.frequencies)
	cloneColumn(c, &copied.fieldIndices, &p.fieldIndices)
	cloneColumn(c, &copied.positionStarts, &p.positionStarts)
	return copied
}

func (p *positionPool) clone(c *cloning) *positionPool {
	copied := &positionPool{allocation: slices.Clone(p.allocation)}
	cloneColumn(c, &copied.values, &p.values)
	return copied
}

func (t *surfaceTable) cloneInto(c *cloning, copied *surfaceTable) {
	copied.strings = t.strings.clone(c)
	cloneColumn(c, &copied.token, &t.token)
	cloneColumn(c, &copied.count, &t.count)
}

func (t *runTable) clone(c *cloning) *runTable {
	copied := &runTable{header: slices.Clone(t.header), allocation: slices.Clone(t.allocation),
		freeHeads: slices.Clone(t.freeHeads)}
	cloneColumn(c, &copied.slots, &t.slots)
	cloneColumn(c, &copied.runs, &t.runs)
	cloneColumn(c, &copied.listStart, &t.listStart)
	cloneColumn(c, &copied.listLength, &t.listLength)
	cloneColumn(c, &copied.listClass, &t.listClass)
	cloneColumn(c, &copied.members, &t.members)
	return copied
}

func (t *spellingTable) clone(c *cloning) *spellingTable {
	copied := &spellingTable{}
	t.surfaceTable.cloneInto(c, &copied.surfaceTable)
	cloneColumn(c, &copied.codePoints, &t.codePoints)
	if t.runs != nil {
		copied.runs = t.runs.clone(c)
	}
	return copied
}

func (f *fieldLengths) clone(c *cloning) fieldLengths {
	copied := fieldLengths{documents: slices.Clone(f.documents), ordinalCapacity: f.ordinalCapacity, fieldCount: f.fieldCount}
	cloneColumn(c, &copied.values, &f.values)
	cloneColumn(c, &copied.totals, &f.totals)
	cloneColumn(c, &copied.partial, &f.partial)
	return copied
}

func (s *Segment) Clone() (*Segment, error) {
	if s.released {
		return nil, releasedRefusal()
	}
	c := &cloning{}
	copied := &Segment{terms: s.terms.clone(c), postings: s.postings.clone(c), fields: s.fields.clone(c),
		held: ordinalSet{words: slices.Clone(s.held.words)}}
	cloneColumn(c, &copied.retired, &s.retired)
	if s.positions != nil {
		copied.positions = s.positions.clone(c)
	}
	if s.surfaces != nil {
		copied.surfaces = &surfaceTable{}
		s.surfaces.cloneInto(c, copied.surfaces)
	}
	if s.spellings != nil {
		copied.spellings = s.spellings.clone(c)
	}
	if c.err != nil {
		copied.Release()
		return nil, c.err
	}
	copied.refreshView()
	return copied, nil
}
