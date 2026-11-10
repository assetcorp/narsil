package partition

import (
	"sort"
	"sync/atomic"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/bitset"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/frozen"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partialwords"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/postings"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type frozenSub struct {
	segment            *frozen.Segment
	tombstones         bitset.Bits
	live               bitset.Bits
	removedCount       int
	arrivals           []uint32
	removedDocuments   []uint32
	removedOccurrences []float64
	lengthTotals       map[string]float64
	removedSurfaces    map[string]int
	removedStemTotals  map[string]int
	vanishedSurfaces   int
	sortedIDs          atomic.Pointer[[]string]
	partial            *partialwords.FrozenRemovals
}

func newFrozenSub(segment *frozen.Segment) *frozenSub {
	count := segment.DocumentCount()
	live := bitset.New(count)
	for ordinal := 0; ordinal < count; ordinal++ {
		live.Set(uint32(ordinal))
	}
	sub := &frozenSub{segment: segment, tombstones: bitset.New(count), live: live}
	if table := segment.PartialWords(); table != nil {
		sub.partial = partialwords.NewFrozenRemovals(table, segment.TokenAt)
	}
	return sub
}

func (f *frozenSub) liveCount() int {
	return f.segment.DocumentCount() - f.removedCount
}

func (f *frozenSub) holdsLive(id string) (uint32, bool) {
	ordinal, found := f.segment.Ordinal(id)
	if !found || f.tombstones.Has(ordinal) {
		return 0, false
	}
	return ordinal, true
}

func (f *frozenSub) tombstone(ordinal uint32, text analysedText) bool {
	if int(ordinal) >= f.segment.DocumentCount() || f.tombstones.Has(ordinal) {
		return false
	}
	f.tombstones.Set(ordinal)
	f.live.Clear(ordinal)
	f.removedCount++
	f.arrivals = append(f.arrivals, ordinal)
	f.sortedIDs.Store(nil)
	f.countRemovedTokens(text)
	if f.partial != nil {
		_ = f.partial.Apply(text.removedSpellings, nil)
	}
	if f.lengthTotals == nil {
		f.lengthTotals = make(map[string]float64, len(f.segment.TotalFieldLengths()))
		for field, total := range f.segment.TotalFieldLengths() {
			f.lengthTotals[field] = total
		}
	}
	for _, field := range f.segment.LengthNames() {
		if column := f.segment.LengthColumn(field); int(ordinal) < len(column) {
			f.lengthTotals[field] -= float64(column[ordinal])
		}
	}
	return true
}

func (f *frozenSub) countRemovedTokens(text analysedText) {
	if f.removedDocuments == nil {
		f.removedDocuments = make([]uint32, f.segment.TokenCount())
		f.removedOccurrences = make([]float64, f.segment.TokenCount())
	}
	counted := map[int]struct{}{}
	for _, field := range text.fields {
		for _, token := range field.tokens {
			at, found := f.segment.FindToken(token.term)
			if !found {
				continue
			}
			if _, seen := counted[at]; !seen {
				counted[at] = struct{}{}
				f.removedDocuments[at] = min(f.removedDocuments[at]+1, f.segment.StoredDocumentFrequency(at))
			}
			f.removedOccurrences[at] += float64(min(token.count, maxTermFrequency))
		}
		for _, surface := range field.surfaces {
			f.subtractSurface(surface.surface, surface.count)
		}
	}
}

func (f *frozenSub) surfaceOccurrences(surface string) (frozen.SurfaceForm, bool) {
	for _, form := range f.segment.SurfacesWithPrefix(surface) {
		if form.Surface == surface {
			return form, true
		}
	}
	return frozen.SurfaceForm{}, false
}

func (f *frozenSub) subtractSurface(surface string, occurrences int) {
	form, held := f.surfaceOccurrences(surface)
	if !held || occurrences <= 0 {
		return
	}
	if f.removedSurfaces == nil {
		f.removedSurfaces = map[string]int{}
		f.removedStemTotals = map[string]int{}
	}
	remaining := form.Occurrences - f.removedSurfaces[surface]
	if remaining <= 0 {
		return
	}
	removed := min(occurrences, remaining)
	f.removedSurfaces[surface] += removed
	f.removedStemTotals[form.Token] += removed
	if removed == remaining {
		f.vanishedSurfaces++
	}
}

func (f *frozenSub) liveSurfaces() []frozen.SurfaceForm {
	forms := f.segment.Surfaces()
	if f.removedSurfaces == nil {
		return forms
	}
	kept := make([]frozen.SurfaceForm, 0, len(forms))
	for _, form := range forms {
		form.Occurrences -= f.removedSurfaces[form.Surface]
		if form.Occurrences > 0 {
			kept = append(kept, form)
		}
	}
	return kept
}

func (f *frozenSub) liveFrequencyAt(at int) uint32 {
	stored := f.segment.StoredDocumentFrequency(at)
	if f.removedDocuments == nil {
		return stored
	}
	return stored - f.removedDocuments[at]
}

func (f *frozenSub) listAt(at int) (postings.List, bool, error) {
	live := f.liveFrequencyAt(at)
	if live == 0 {
		return postings.List{}, false, nil
	}
	list, err := f.segment.List(at, live, f.segment.StoredDocumentFrequency(at)-live)
	if err != nil {
		return postings.List{}, false, err
	}
	return list, true, nil
}

func (f *frozenSub) lookup(token string) (postings.List, bool, error) {
	at, found := f.segment.FindToken(token)
	if !found {
		return postings.List{}, false, nil
	}
	return f.listAt(at)
}

func (f *frozenSub) fuzzyPositions(token string, tolerance, prefixLength int) []int {
	if tolerance == 0 {
		if at, found := f.segment.FindToken(token); found && f.liveFrequencyAt(at) > 0 {
			return []int{at}
		}
		return nil
	}
	start, end := f.segment.PrefixRange(postings.FuzzyPrefixOf(token, prefixLength))
	var positions []int
	for at := start; at < end; at++ {
		if postings.WithinDistance(token, f.segment.TokenAt(at), tolerance) && f.liveFrequencyAt(at) > 0 {
			positions = append(positions, at)
		}
	}
	return positions
}

func (f *frozenSub) fuzzy(token string, tolerance, prefixLength int) ([]postings.Match, error) {
	positions := f.fuzzyPositions(token, tolerance, prefixLength)
	matches := make([]postings.Match, 0, len(positions))
	for _, at := range positions {
		list, found, err := f.listAt(at)
		if err != nil {
			return nil, err
		}
		if found {
			matches = append(matches, postings.Match{Token: f.segment.TokenAt(at), List: list})
		}
	}
	if len(matches) == 0 {
		return nil, nil
	}
	return matches, nil
}

func (f *frozenSub) fuzzyTokens(token string, tolerance, prefixLength int) []string {
	positions := f.fuzzyPositions(token, tolerance, prefixLength)
	tokens := make([]string, len(positions))
	for at, position := range positions {
		tokens[at] = f.segment.TokenAt(position)
	}
	return tokens
}

func (f *frozenSub) documentFrequency(token string) uint32 {
	at, found := f.segment.FindToken(token)
	if !found {
		return 0
	}
	return f.liveFrequencyAt(at)
}

func (f *frozenSub) holdsToken(token string) bool {
	return f.documentFrequency(token) > 0
}

func (f *frozenSub) pool() postings.Pool {
	return f.segment.Pool()
}

func (f *frozenSub) removedBits() bitset.Bits {
	return f.tombstones
}

func (f *frozenSub) isRemoved(ordinal uint32) bool {
	return f.tombstones.Has(ordinal)
}

func (f *frozenSub) liveBits() bitset.Bits {
	return f.live
}

func (f *frozenSub) ordinalCapacity() uint32 {
	return uint32(f.segment.DocumentCount())
}

func (f *frozenSub) names() []string {
	return f.segment.FieldNames()
}

func (f *frozenSub) lengthColumn(field string) []uint32 {
	return f.segment.LengthColumn(field)
}

func (f *frozenSub) documentCount() int {
	return f.liveCount()
}

func (f *frozenSub) totalLengths() map[string]float64 {
	if f.lengthTotals != nil {
		return f.lengthTotals
	}
	return f.segment.TotalFieldLengths()
}

func (f *frozenSub) averageLength(field string) (float64, bool) {
	documents := f.liveCount()
	total, found := f.totalLengths()[field]
	if !found || documents == 0 {
		return 0, false
	}
	return total / float64(documents), true
}

func (f *frozenSub) documentAt(ordinal uint32) (*StoredDocument, error) {
	if f.tombstones.Has(ordinal) {
		return nil, nil
	}
	return f.segment.DocumentAt(ordinal)
}

func (f *frozenSub) idAt(ordinal uint32) (string, bool) {
	if f.tombstones.Has(ordinal) {
		return "", false
	}
	return f.segment.IDAt(ordinal)
}

func (f *frozenSub) heldDocument(ordinal uint32) *StoredDocument {
	if f.tombstones.Has(ordinal) {
		return nil
	}
	return f.segment.HeldDocument(ordinal)
}

func (f *frozenSub) sortedDocumentIDs() []string {
	if held := f.sortedIDs.Load(); held != nil {
		return *held
	}
	ids := make([]string, 0, f.liveCount())
	for _, ordinal := range f.segment.SortedOrdinals() {
		if id, live := f.idAt(ordinal); live {
			ids = append(ids, id)
		}
	}
	sort.SliceStable(ids, func(left, right int) bool { return text.CompareCodePoints(ids[left], ids[right]) < 0 })
	f.sortedIDs.CompareAndSwap(nil, &ids)
	return ids
}
