package engine

import "github.com/assetcorp/narsil/packages/go/engine/internal/index"

type retiredBatch struct {
	generation uint64
	indexes    []*index.Index
}

type retirements struct {
	generation uint64
	entered    map[uint64]int
	waiting    []retiredBatch
}

func (r *retirements) enter() uint64 {
	if r.entered == nil {
		r.entered = map[uint64]int{}
	}
	r.entered[r.generation]++
	return r.generation
}

func (r *retirements) leave(generation uint64) []*index.Index {
	if r.entered[generation]--; r.entered[generation] <= 0 {
		delete(r.entered, generation)
	}
	return r.releasable()
}

func (r *retirements) retire(indexes []*index.Index) []*index.Index {
	r.waiting = append(r.waiting, retiredBatch{generation: r.generation, indexes: indexes})
	r.generation++
	return r.releasable()
}

func (r *retirements) releasable() []*index.Index {
	oldest := r.generation
	for generation := range r.entered {
		oldest = min(oldest, generation)
	}
	var released []*index.Index
	kept := r.waiting[:0]
	for _, batch := range r.waiting {
		if batch.generation < oldest {
			released = append(released, batch.indexes...)
		} else {
			kept = append(kept, batch)
		}
	}
	clear(r.waiting[len(kept):])
	r.waiting = kept
	return released
}

func releaseIndexes(indexes []*index.Index) {
	for _, held := range indexes {
		held.Release()
	}
}

func (n *Narsil) retireIndexes(indexes ...*index.Index) {
	distinct := make([]*index.Index, 0, len(indexes))
	for _, held := range indexes {
		if held != nil && !containsIndex(distinct, held) {
			distinct = append(distinct, held)
		}
	}
	if len(distinct) == 0 {
		return
	}
	n.lifeMu.Lock()
	released := n.retired.retire(distinct)
	n.lifeMu.Unlock()
	releaseIndexes(released)
}

func (n *Narsil) retireReplaced(entry *indexEntry, candidates ...*index.Index) {
	live := entry.index()
	replaced := make([]*index.Index, 0, len(candidates))
	for _, candidate := range candidates {
		if candidate != live {
			replaced = append(replaced, candidate)
		}
	}
	n.retireIndexes(replaced...)
}

func containsIndex(indexes []*index.Index, wanted *index.Index) bool {
	for _, held := range indexes {
		if held == wanted {
			return true
		}
	}
	return false
}
