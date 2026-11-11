package vector

import (
	"sync"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
)

type ordinalHit struct {
	ordinal int32
	score   float64
}

type searchScratch struct {
	workspace  *core.Workspace
	candidates []int32
	estimates  []float64
	picked     []int32
	distances  []float64
	batch      []int32
	hits       []ordinalHit
}

var searchScratchPool = sync.Pool{New: func() any { return &searchScratch{} }}

func acquireSearchScratch() (*searchScratch, error) {
	scratch, _ := searchScratchPool.Get().(*searchScratch)
	if scratch == nil {
		scratch = &searchScratch{}
	}
	workspace, err := core.AcquireWorkspace()
	if err != nil {
		searchScratchPool.Put(scratch)
		return nil, coreFailure("workspaceCreate", err)
	}
	scratch.workspace = workspace
	return scratch, nil
}

func (s *searchScratch) release() {
	if s.workspace != nil {
		s.workspace.Release()
		s.workspace = nil
	}
	if cap(s.candidates) > searchScratchKeptEntries {
		s.candidates, s.estimates = nil, nil
	}
	if cap(s.distances) > searchScratchKeptEntries || cap(s.hits) > searchScratchKeptEntries {
		s.distances, s.hits, s.picked = nil, nil, nil
	}
	s.hits = s.hits[:0]
	s.batch = s.batch[:0]
	s.picked = s.picked[:0]
	searchScratchPool.Put(s)
}

func grown[T any](held []T, count int) []T {
	if cap(held) >= count {
		return held[:count]
	}
	return make([]T, count, max(count, cap(held)*2))
}

func (s *searchScratch) distancesFor(count int) []float64 {
	s.distances = grown(s.distances, count)
	return s.distances
}

func (s *searchScratch) candidatesFor(count int) ([]int32, []float64) {
	s.candidates = grown(s.candidates, count)
	s.estimates = grown(s.estimates, count)
	return s.candidates, s.estimates
}
