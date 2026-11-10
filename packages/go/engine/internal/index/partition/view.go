package partition

import (
	"sort"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/bitset"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/fieldindex"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/geo"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/postings"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type View struct {
	state    *side
	tailOnly bool
	failure  *readFailure
}

func (p *Partition) Read(visit func(view View)) {
	p.pair.read(func(state *side) { visit(View{state: state, failure: &readFailure{}}) })
}

func (p *Partition) Acquire() (View, func()) {
	current := p.pair.acquire()
	released := false
	return View{state: current.state, failure: &readFailure{}}, func() {
		if released {
			return
		}
		released = true
		current.readers.Add(-1)
	}
}

func (v View) sources() []keywordSource {
	if v.tailOnly || len(v.state.frozen) == 0 {
		return []keywordSource{v.state}
	}
	return v.state.subSources()
}

func (v View) layout() ordinalLayout {
	return layoutOf(v.sources())
}

func (v View) LiveTail() View {
	return View{state: v.state, tailOnly: true, failure: v.failure}
}

func (v View) HoldsFrozenSegments() bool {
	return !v.tailOnly && len(v.state.frozen) > 0
}

func (v View) SearchFulltext(params *SearchParams) (SearchResult, error) {
	if v.tailOnly {
		return searcher{src: v.state}.searchFulltext(params)
	}
	return v.state.searchComposite(params)
}

func (v View) Count() int {
	total := 0
	for _, sub := range v.sources() {
		total += sub.documentCount()
	}
	return total
}

func (v View) Capacity() uint32 {
	if !v.HoldsFrozenSegments() {
		return v.state.documents.capacity()
	}
	return v.layout().total
}

func (v View) OrdinalCapacity() int {
	return int(v.Capacity())
}

func (v View) Live() bitset.Bits {
	if !v.HoldsFrozenSegments() {
		return v.state.documents.live
	}
	sources := v.sources()
	layout := layoutOf(sources)
	live := bitset.New(int(layout.total))
	for at, sub := range sources {
		layout.place(live, at, sub.liveBits())
	}
	return live
}

func (v View) Document(id string) (*StoredDocument, uint32, bool) {
	document, ordinal, found, err := v.DocumentRead(id)
	if err != nil {
		v.failure.record(err)
		return nil, 0, false
	}
	return document, ordinal, found
}

func (v View) DocumentAt(ordinal uint32) *StoredDocument {
	document, err := v.DocumentAtRead(ordinal)
	if err != nil {
		v.failure.record(err)
		return nil
	}
	return document
}

func (v View) StoredDocument(ordinal uint32) (map[string]any, bool) {
	document := v.DocumentAt(ordinal)
	if document == nil {
		return nil, false
	}
	return document.Fields, true
}

func (v View) OrdinalOf(id string) (uint32, bool) {
	if !v.HoldsFrozenSegments() {
		_, ordinal, found := v.state.documents.get(id)
		return ordinal, found
	}
	layout := v.layout()
	for at, sub := range v.state.frozen {
		if ordinal, found := sub.holdsLive(id); found {
			return layout.bases[at] + ordinal, true
		}
	}
	_, ordinal, found := v.state.documents.get(id)
	return layout.bases[len(layout.bases)-1] + ordinal, found
}

func (v View) ForEachDocument(visit func(ordinal uint32, document *StoredDocument) bool) {
	v.failure.record(v.EachDocument(visit))
}

func (v View) SortedDocumentIDs() []string {
	if !v.HoldsFrozenSegments() {
		return v.state.documents.sortedDocumentIDs()
	}
	var merged []string
	for _, sub := range v.state.frozen {
		merged = append(merged, sub.sortedDocumentIDs()...)
	}
	merged = append(merged, v.state.documents.sortedDocumentIDs()...)
	sort.SliceStable(merged, func(left, right int) bool { return text.CompareCodePoints(merged[left], merged[right]) < 0 })
	return merged
}

func (v View) TotalDocuments() int {
	return v.Count()
}

func (v View) TotalFieldLengths() map[string]float64 {
	if !v.HoldsFrozenSegments() {
		return v.state.statistics.totals()
	}
	_, totals := aggregateFieldStats(v.sources())
	return totals
}

func (v View) DocumentFrequency(token string) (uint32, bool) {
	total, present := uint32(0), false
	for _, sub := range v.sources() {
		if sub.holdsToken(token) {
			present = true
			total += sub.documentFrequency(token)
		}
	}
	return total, present
}

func (v View) FuzzyTokens(token string, tolerance, prefixLength int) []string {
	var tokens []string
	seen := map[string]struct{}{}
	for _, sub := range v.sources() {
		for _, candidate := range sub.fuzzyTokens(token, tolerance, prefixLength) {
			if _, held := seen[candidate]; !held {
				seen[candidate] = struct{}{}
				tokens = append(tokens, candidate)
			}
		}
	}
	return tokens
}

func (v View) PrefixSearch(prefix string, limit int) []postings.Suggestion {
	if !v.HoldsFrozenSegments() {
		return v.state.postings.PrefixSearch(prefix, limit)
	}
	if prefix == "" || limit <= 0 {
		return nil
	}
	totals := map[string]uint32{}
	for _, sub := range v.sources() {
		for _, suggestion := range sub.prefixSuggestions(prefix) {
			totals[suggestion.Term] += suggestion.DocumentFrequency
		}
	}
	results := make([]postings.Suggestion, 0, len(totals))
	for term, frequency := range totals {
		results = append(results, postings.Suggestion{Term: term, DocumentFrequency: frequency})
	}
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

func (v View) Geopoint(path string) *geo.Index {
	return v.state.geopoints[path]
}

func (v View) ValueSizes(path string) *fieldindex.Numeric {
	return v.state.sizes[path]
}

func (v View) NumericIndex(path string) *fieldindex.Numeric {
	return v.state.numbers[path]
}

func (v View) BooleanIndex(path string) *fieldindex.Boolean {
	return v.state.booleans[path]
}

func (v View) EnumIndex(path string) *fieldindex.Enum {
	return v.state.enums[path]
}
