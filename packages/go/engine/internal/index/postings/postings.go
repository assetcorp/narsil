package postings

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/bitset"
)

type Index struct {
	terms          termTable
	pool           pool
	positions      positionPool
	retired        bitset.Bits
	batch          bool
	dirty          map[uint32]struct{}
	compactedSlack int
}

func New() *Index {
	return &Index{terms: newTermTable(), retired: bitset.New(0), dirty: map[uint32]struct{}{}}
}

func holdsDocument(docIDs []uint32, ordinal uint32, ordered bool) bool {
	if !ordered {
		for _, held := range docIDs {
			if held == ordinal {
				return true
			}
		}
		return false
	}
	low, high := 0, len(docIDs)
	for low < high {
		middle := int(uint(low+high) >> 1)
		if docIDs[middle] < ordinal {
			low = middle + 1
		} else {
			high = middle
		}
	}
	return low < len(docIDs) && docIDs[low] == ordinal
}

func (x *Index) Insert(token string, ordinal uint32, termFrequency uint32, field uint16, positions []uint32, keepsPositions bool) {
	if x.retired.Has(ordinal) {
		x.purgeRetired()
	}
	termOrdinal, found := x.terms.ids[token]
	if !found {
		termOrdinal = x.terms.add(token)
	}
	column := &x.terms.columns[termOrdinal]
	if column.length >= sliceCapacity(column.class) {
		x.relocate(termOrdinal, column.length+1)
		column = &x.terms.columns[termOrdinal]
	}
	start := column.start
	at := start + column.length
	newDocument := true
	if column.length > 0 {
		last := x.pool.docIDs[at-1]
		ordered := column.flags&termOrdered != 0
		if ordinal == last {
			newDocument = false
		} else if !ordered || ordinal < last {
			newDocument = !holdsDocument(x.pool.docIDs[start:at], ordinal, ordered)
			if ordinal < last {
				column.flags &^= termOrdered
			}
		}
	}
	stored := min(termFrequency, MaxTermFrequency)
	x.pool.docIDs[at] = ordinal
	x.pool.frequencies[at] = uint16(stored)
	x.pool.fields[at] = field
	column.totalTermFrequency += float64(stored)
	if keepsPositions {
		x.pool.trackPositions()
		if column.flags&termPositions == 0 {
			column.flags |= termPositions
			for index := start; index < at; index++ {
				x.pool.positionStarts[index] = noPositions
			}
		}
		x.pool.positionStarts[at] = x.positions.append(positions)
	} else if column.flags&termPositions != 0 {
		x.pool.positionStarts[at] = noPositions
	}
	if newDocument {
		column.documentFrequency++
	}
	column.length++
	x.repackIfSparse()
}

func (x *Index) Remove(token string, ordinal uint32, occurrences uint32) {
	termOrdinal, found := x.terms.ids[token]
	if !found {
		return
	}
	column := &x.terms.columns[termOrdinal]
	if !holdsDocument(x.pool.docIDs[column.start:column.start+column.length], ordinal, column.flags&termOrdered != 0) {
		return
	}
	column.documentFrequency--
	column.deadDocuments++
	x.retire(ordinal)
	column.totalTermFrequency = max(0, column.totalTermFrequency-float64(occurrences))
	if column.documentFrequency == 0 {
		x.dropTerm(termOrdinal)
		return
	}
	if x.batch {
		x.dirty[termOrdinal] = struct{}{}
		return
	}
	if float64(column.deadDocuments)/float64(column.length) > postingListCompactionFraction {
		x.compact(termOrdinal)
	}
	x.repackIfSparse()
}

func (x *Index) BeginBatch() {
	x.batch = true
	clear(x.dirty)
}

func (x *Index) EndBatch() {
	x.batch = false
	for termOrdinal := range x.dirty {
		if int(termOrdinal) >= len(x.terms.columns) || !x.terms.isLive(termOrdinal) {
			continue
		}
		column := x.terms.columns[termOrdinal]
		if float64(column.deadDocuments)/float64(column.length) > postingListCompactionFraction {
			x.compact(termOrdinal)
		}
	}
	clear(x.dirty)
	x.repackIfSparse()
}

func (x *Index) Clear() {
	*x = Index{terms: newTermTable(), retired: bitset.New(0), dirty: map[uint32]struct{}{}}
}

func (x *Index) retire(ordinal uint32) {
	x.retired = bitset.Grown(x.retired, ordinal)
	x.retired.Set(ordinal)
}

func (x *Index) purgeRetired() {
	for termOrdinal := range x.terms.columns {
		if x.terms.isLive(uint32(termOrdinal)) && x.terms.columns[termOrdinal].deadDocuments > 0 {
			x.compact(uint32(termOrdinal))
		}
	}
	clear(x.retired)
}

func (x *Index) compact(termOrdinal uint32) {
	if x.terms.columns[termOrdinal].deadDocuments == 0 {
		return
	}
	x.filterEntries(termOrdinal)
	x.terms.columns[termOrdinal].deadDocuments = 0
}

func (x *Index) filterEntries(termOrdinal uint32) {
	column := &x.terms.columns[termOrdinal]
	start := column.start
	length := column.length
	tracks := column.flags&termPositions != 0 && x.pool.tracksPositions()
	kept := uint32(0)
	ascending := true
	for index := start; index < start+length; index++ {
		ordinal := x.pool.docIDs[index]
		if x.retired.Has(ordinal) {
			if tracks {
				x.positions.release(x.pool.positionStarts[index])
			}
			continue
		}
		target := start + kept
		if kept > 0 && ordinal < x.pool.docIDs[target-1] {
			ascending = false
		}
		if target != index {
			x.pool.docIDs[target] = ordinal
			x.pool.frequencies[target] = x.pool.frequencies[index]
			x.pool.fields[target] = x.pool.fields[index]
			if tracks {
				x.pool.positionStarts[target] = x.pool.positionStarts[index]
			}
		}
		kept++
	}
	column.length = kept
	if ascending {
		column.flags |= termOrdered
	} else {
		column.flags &^= termOrdered
	}
	x.compactedSlack += int(length - kept)
}

func (x *Index) relocate(termOrdinal uint32, needed uint32) {
	column := &x.terms.columns[termOrdinal]
	previousClass := column.class
	grownClass := uint8(0)
	if previousClass != noSlice {
		grownClass = min(previousClass+1, sliceClassCount-1)
	}
	nextClass := max(grownClass, sliceClassFor(needed))
	nextStart := x.pool.allocate(nextClass)
	if column.length > 0 {
		x.pool.move(column.start, nextStart, column.length)
	}
	x.pool.release(column.start, previousClass)
	column.start = nextStart
	column.class = nextClass
}

func (x *Index) dropTerm(termOrdinal uint32) {
	column := x.terms.columns[termOrdinal]
	if column.flags&termPositions != 0 && x.pool.tracksPositions() {
		for index := column.start; index < column.start+column.length; index++ {
			x.positions.release(x.pool.positionStarts[index])
		}
	}
	x.pool.release(column.start, column.class)
	delete(x.dirty, termOrdinal)
	x.terms.kill(termOrdinal)
	if x.terms.deadCount() >= termVacuumMinDeadTerms && x.terms.deadCount() > x.terms.liveCount {
		x.renumberTerms()
	}
}

func (x *Index) renumberTerms() {
	remap := x.terms.renumber()
	dirty := make(map[uint32]struct{}, len(x.dirty))
	for termOrdinal := range x.dirty {
		if target := remap[termOrdinal]; target >= 0 {
			dirty[uint32(target)] = struct{}{}
		}
	}
	x.dirty = dirty
}

func (x *Index) repackIfSparse() {
	freeEntries := x.pool.freeEntries + x.compactedSlack
	sparsePostings := freeEntries >= poolVacuumMinFreeEntries && float64(freeEntries) > float64(x.pool.end)*poolVacuumFreeFraction
	sparsePositions := x.positions.sparse()
	if sparsePostings || sparsePositions {
		x.repack(sparsePositions)
	}
}

func (x *Index) repack(rebuildPositions bool) {
	capacity := 0
	x.terms.forEachLive(func(termOrdinal uint32) {
		capacity += int(sliceCapacity(sliceClassFor(x.terms.columns[termOrdinal].length)))
	})
	next := pool{
		docIDs:      make([]uint32, 0, max(1, capacity)),
		frequencies: make([]uint16, 0, max(1, capacity)),
		fields:      make([]uint16, 0, max(1, capacity)),
	}
	if x.pool.tracksPositions() {
		next.positionStarts = make([]uint32, 0, max(1, capacity))
	}
	nextPositions := x.positions
	if rebuildPositions {
		nextPositions = positionPool{values: make([]uint32, 0, max(1, len(x.positions.values)-x.positions.free))}
	}
	x.terms.forEachLive(func(termOrdinal uint32) {
		column := &x.terms.columns[termOrdinal]
		class := sliceClassFor(column.length)
		target := next.allocate(class)
		from, to := column.start, column.start+column.length
		copy(next.docIDs[target:], x.pool.docIDs[from:to])
		copy(next.frequencies[target:], x.pool.frequencies[from:to])
		copy(next.fields[target:], x.pool.fields[from:to])
		if column.flags&termPositions != 0 && x.pool.tracksPositions() {
			for row := uint32(0); row < column.length; row++ {
				held := x.pool.positionStarts[from+row]
				if rebuildPositions && held != noPositions {
					next.positionStarts[target+row] = nextPositions.append(x.positions.read(held))
				} else {
					next.positionStarts[target+row] = held
				}
			}
		}
		column.start = target
		column.class = class
	})
	x.pool = next
	x.positions = nextPositions
	x.compactedSlack = 0
}
