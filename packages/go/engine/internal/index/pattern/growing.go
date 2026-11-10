package pattern

import (
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/bitset"
)

type runList struct {
	ids     []uint32
	removed map[uint32]struct{}
}

func (list *runList) insert(ordinal uint32) {
	if len(list.ids) == 0 || list.ids[len(list.ids)-1] <= ordinal {
		list.ids = append(list.ids, ordinal)
		return
	}
	at, _ := slices.BinarySearch(list.ids, ordinal)
	list.ids = slices.Insert(list.ids, at, ordinal)
}

func (list *runList) compact() {
	if list.removed == nil {
		return
	}
	kept := list.ids[:0]
	for _, ordinal := range list.ids {
		if _, removed := list.removed[ordinal]; !removed {
			kept = append(kept, ordinal)
		}
	}
	list.ids = kept
	list.removed = nil
}

func (list *runList) settled() []uint32 {
	if len(list.removed) == 0 {
		return list.ids[:len(list.ids):len(list.ids)]
	}
	kept := make([]uint32, 0, len(list.ids))
	for _, ordinal := range list.ids {
		if _, removed := list.removed[ordinal]; !removed {
			kept = append(kept, ordinal)
		}
	}
	return kept
}

type Growing struct {
	runs          map[runKey]*runList
	documents     bitset.Bits
	documentCount int
	listBytes     int
	folded        []rune
}

func NewGrowing() *Growing {
	return &Growing{runs: map[runKey]*runList{}}
}

func (index *Growing) runKeysOf(value any) map[runKey]struct{} {
	keys := map[runKey]struct{}{}
	forEachTextValue(value, func(source string) bool {
		index.folded = appendTextCodePoints(index.folded[:0], source, true)
		collectRunKeys(index.folded, keys)
		return true
	})
	return keys
}

func (index *Growing) listFor(key runKey) *runList {
	list, held := index.runs[key]
	if !held {
		list = &runList{}
		index.runs[key] = list
	}
	return list
}

func (index *Growing) appendTo(list *runList, ordinal uint32) {
	if _, removed := list.removed[ordinal]; removed {
		delete(list.removed, ordinal)
		return
	}
	before := cap(list.ids)
	list.insert(ordinal)
	index.listBytes += (cap(list.ids) - before) * uint32Bytes
}

func (index *Growing) appendSorted(list *runList, added []uint32) {
	if len(added) == 0 {
		return
	}
	slices.Sort(added)
	before := cap(list.ids)
	if len(list.ids) == 0 || list.ids[len(list.ids)-1] <= added[0] {
		list.ids = append(list.ids, added...)
	} else {
		merged := make([]uint32, 0, len(list.ids)+len(added))
		existing := list.ids
		for len(existing) > 0 && len(added) > 0 {
			if existing[0] <= added[0] {
				merged = append(merged, existing[0])
				existing = existing[1:]
			} else {
				merged = append(merged, added[0])
				added = added[1:]
			}
		}
		merged = append(merged, existing...)
		list.ids = append(merged, added...)
	}
	index.listBytes += (cap(list.ids) - before) * uint32Bytes
}

func (index *Growing) dropIfEmpty(key runKey, list *runList) {
	if len(list.ids) > 0 {
		return
	}
	index.listBytes -= cap(list.ids) * uint32Bytes
	delete(index.runs, key)
}

func (index *Growing) markRemoved(key runKey, list *runList, ordinal uint32) {
	if list.removed == nil {
		list.removed = map[uint32]struct{}{}
	}
	list.removed[ordinal] = struct{}{}
	if len(list.removed)*runListCompactionHalves < len(list.ids) {
		return
	}
	list.compact()
	index.dropIfEmpty(key, list)
}

func (index *Growing) addDocument(ordinal uint32) {
	if index.documents.Has(ordinal) {
		return
	}
	index.documents = bitset.Grown(index.documents, ordinal)
	index.documents.Set(ordinal)
	index.documentCount++
}

func (index *Growing) Add(ordinal uint32, value any) {
	if !holdsTextValue(value) {
		return
	}
	index.addDocument(ordinal)
	for key := range index.runKeysOf(value) {
		index.appendTo(index.listFor(key), ordinal)
	}
}

func (index *Growing) Remove(ordinal uint32, value any) {
	if !holdsTextValue(value) {
		return
	}
	if index.documents.Has(ordinal) {
		index.documents.Clear(ordinal)
		index.documentCount--
	}
	for key := range index.runKeysOf(value) {
		if list, held := index.runs[key]; held {
			index.markRemoved(key, list, ordinal)
		}
	}
}

func (index *Growing) AddArrays(arrays Arrays, mapOrdinal func(ordinal uint32) (uint32, bool)) {
	for _, ordinal := range arrays.Documents {
		if mapped, kept := mapOrdinal(ordinal); kept {
			index.addDocument(mapped)
		}
	}
	for run := range min(arrays.RunCount(), len(arrays.Runs)/RunCodePoints) {
		at := run * RunCodePoints
		key := runKey{arrays.Runs[at], arrays.Runs[at+1], arrays.Runs[at+2]}
		list := index.listFor(key)
		var added []uint32
		for _, ordinal := range arrays.postingsAt(run) {
			mapped, kept := mapOrdinal(ordinal)
			if !kept {
				continue
			}
			if _, removed := list.removed[mapped]; removed {
				delete(list.removed, mapped)
				continue
			}
			added = append(added, mapped)
		}
		index.appendSorted(list, added)
		index.dropIfEmpty(key, list)
	}
}

func (index *Growing) Clear() {
	clear(index.runs)
	index.documents = nil
	index.documentCount = 0
	index.listBytes = 0
}

func (index *Growing) Documents() []uint32 {
	documents := make([]uint32, 0, index.documentCount)
	index.documents.ForEach(func(ordinal uint32) bool {
		documents = append(documents, ordinal)
		return true
	})
	return documents
}

func (index *Growing) Postings(first, second, third uint32) []uint32 {
	list, held := index.runs[runKey{first, second, third}]
	if !held {
		return nil
	}
	return list.settled()
}

func (index *Growing) runSource() runSource {
	keys := make([]runKey, 0, len(index.runs))
	for key := range index.runs {
		keys = append(keys, key)
	}
	slices.SortFunc(keys, compareRunKeys)
	lists := make([][]uint32, 0, len(keys))
	codePoints := make([]uint32, 0, len(keys)*RunCodePoints)
	for _, key := range keys {
		postings := index.runs[key].settled()
		if len(postings) == 0 {
			continue
		}
		lists = append(lists, postings)
		codePoints = append(codePoints, key[0], key[1], key[2])
	}
	return runSource{count: len(lists), codePoints: codePoints, postingsAt: func(run int) []uint32 { return lists[run] }}
}

func (index *Growing) Arrays(field string) Arrays {
	return buildArrays(field, index.Documents(), index.runSource(), nil, nil, true)
}

func (index *Growing) RemappedArrays(field string, remap []int32) Arrays {
	return buildArrays(field, index.Documents(), index.runSource(), nil, remap, false)
}

func (index *Growing) Bytes() int {
	return index.listBytes + len(index.runs)*runEntryOverheadBytes + index.documentCount*documentEntryBytes
}
