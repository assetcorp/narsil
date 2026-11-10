package postings

import (
	"sort"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/bitset"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type List struct {
	Start             uint32
	DocIDs            []uint32
	Frequencies       []uint16
	Fields            []uint16
	Ordered           bool
	DocumentFrequency uint32
	DeadDocuments     uint32
	Detached          bool
	holdsPositions    bool
	positionStarts    []uint32
	positions         *positionPool
	frozenOffsets     []uint32
	frozenPositions   []uint32
}

type FrozenRows struct {
	Start             uint32
	DocIDs            []uint32
	Frequencies       []uint16
	Fields            []uint16
	Ordered           bool
	DocumentFrequency uint32
	DeadDocuments     uint32
	Detached          bool
	PositionOffsets   []uint32
	Positions         []uint32
}

func FrozenList(rows FrozenRows) List {
	list := List{
		Start:             rows.Start,
		DocIDs:            rows.DocIDs,
		Frequencies:       rows.Frequencies,
		Fields:            rows.Fields,
		Ordered:           rows.Ordered,
		DocumentFrequency: rows.DocumentFrequency,
		DeadDocuments:     rows.DeadDocuments,
		Detached:          rows.Detached,
	}
	if len(rows.PositionOffsets) == len(rows.DocIDs)+1 {
		list.holdsPositions = true
		list.frozenOffsets = rows.PositionOffsets
		list.frozenPositions = rows.Positions
	}
	return list
}

type Match struct {
	Token string
	List  List
}

type Suggestion struct {
	Term              string
	DocumentFrequency uint32
}

type Pool struct {
	DocIDs      []uint32
	Frequencies []uint16
	Fields      []uint16
}

func (l List) Length() int {
	return len(l.DocIDs)
}

func (l List) HoldsPositions() bool {
	return l.holdsPositions
}

func (l List) PositionsAt(row int) []uint32 {
	if !l.holdsPositions || row < 0 {
		return nil
	}
	if l.frozenOffsets != nil {
		if row+1 >= len(l.frozenOffsets) {
			return nil
		}
		from, to := l.frozenOffsets[row], l.frozenOffsets[row+1]
		if from > to || int(to) > len(l.frozenPositions) {
			return nil
		}
		return l.frozenPositions[from:to:to]
	}
	if row >= len(l.positionStarts) {
		return nil
	}
	return l.positions.read(l.positionStarts[row])
}

func (x *Index) view(termOrdinal uint32) List {
	column := x.terms.columns[termOrdinal]
	from, to := column.start, column.start+column.length
	list := List{
		Start:             from,
		DocIDs:            x.pool.docIDs[from:to:to],
		Frequencies:       x.pool.frequencies[from:to:to],
		Fields:            x.pool.fields[from:to:to],
		Ordered:           column.flags&termOrdered != 0,
		DocumentFrequency: column.documentFrequency,
		DeadDocuments:     column.deadDocuments,
	}
	if column.flags&termPositions != 0 && x.pool.tracksPositions() {
		list.holdsPositions = true
		list.positionStarts = x.pool.positionStarts[from:to:to]
		list.positions = &x.positions
	}
	return list
}

func (x *Index) Pool() Pool {
	end := x.pool.end
	return Pool{DocIDs: x.pool.docIDs[:end:end], Frequencies: x.pool.frequencies[:end:end], Fields: x.pool.fields[:end:end]}
}

func (x *Index) Retired() bitset.Bits {
	return x.retired
}

func (x *Index) IsRetired(ordinal uint32) bool {
	return x.retired.Has(ordinal)
}

func (x *Index) Lookup(token string) (List, bool) {
	termOrdinal, found := x.terms.ids[token]
	if !found {
		return List{}, false
	}
	return x.view(termOrdinal), true
}

func (x *Index) DocumentFrequency(token string) uint32 {
	termOrdinal, found := x.terms.ids[token]
	if !found {
		return 0
	}
	return x.terms.columns[termOrdinal].documentFrequency
}

func (x *Index) TotalTermFrequency(token string) float64 {
	termOrdinal, found := x.terms.ids[token]
	if !found {
		return 0
	}
	return x.terms.columns[termOrdinal].totalTermFrequency
}

func (x *Index) Has(token string) bool {
	_, found := x.terms.ids[token]
	return found
}

func (x *Index) Size() int {
	return x.terms.liveCount
}

func (x *Index) FuzzyLookup(token string, tolerance, prefixLength int) []Match {
	if tolerance == 0 {
		list, found := x.Lookup(token)
		if !found {
			return nil
		}
		return []Match{{Token: token, List: list}}
	}
	var matches []Match
	x.terms.forEachStartingWith(FuzzyPrefixOf(token, prefixLength), func(termOrdinal uint32) {
		candidate := x.terms.tokens[termOrdinal]
		if WithinDistance(token, candidate, tolerance) {
			matches = append(matches, Match{Token: candidate, List: x.view(termOrdinal)})
		}
	})
	return matches
}

func (x *Index) ForEachStartingWith(prefix string, visit func(token string, documentFrequency uint32)) {
	x.terms.forEachStartingWith(prefix, func(termOrdinal uint32) {
		visit(x.terms.tokens[termOrdinal], x.terms.columns[termOrdinal].documentFrequency)
	})
}

func (x *Index) PrefixSearch(prefix string, limit int) []Suggestion {
	if prefix == "" || limit <= 0 {
		return nil
	}
	var results []Suggestion
	x.ForEachStartingWith(prefix, func(token string, documentFrequency uint32) {
		results = append(results, Suggestion{Term: token, DocumentFrequency: documentFrequency})
	})
	sort.Slice(results, func(left, right int) bool {
		if results[left].DocumentFrequency != results[right].DocumentFrequency {
			return results[left].DocumentFrequency > results[right].DocumentFrequency
		}
		return text.CompareCodePoints(results[left].Term, results[right].Term) < 0
	})
	if len(results) > limit {
		results = results[:limit]
	}
	return results
}

func (x *Index) ForEachToken(visit func(token string) bool) {
	for termOrdinal, token := range x.terms.tokens {
		if x.terms.isLive(uint32(termOrdinal)) && !visit(token) {
			return
		}
	}
}

func (x *Index) EstimateBytes() int {
	perTerm := termEntryEstimatedBytes + tokenStringHeaderBytes
	return x.terms.estimateBytes() + x.pool.estimateBytes() + cap(x.positions.values)*4 + len(x.retired)*4 +
		x.terms.liveCount*perTerm + x.terms.tokenCodeUnits*2
}
