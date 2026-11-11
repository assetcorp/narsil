package index

import (
	"sync"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partition"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/query"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type recordedIDLookup struct {
	snapshot partition.Snapshot
	mu       sync.Mutex
	failure  error
}

func (lookup *recordedIDLookup) idAt(segment int, ordinal uint32) (string, bool) {
	id, held, err := lookup.snapshot.IDAt(segment, ordinal)
	if err != nil {
		lookup.mu.Lock()
		if lookup.failure == nil {
			lookup.failure = err
		}
		lookup.mu.Unlock()
	}
	return id, held
}

func (lookup *recordedIDLookup) compareHits(left, right query.Hit) int {
	leftID, _ := lookup.idAt(left.Segment, left.Ordinal)
	rightID, _ := lookup.idAt(right.Segment, right.Ordinal)
	return text.CompareCodePoints(leftID, rightID)
}

func (lookup *recordedIDLookup) err() error {
	lookup.mu.Lock()
	defer lookup.mu.Unlock()
	return lookup.failure
}
