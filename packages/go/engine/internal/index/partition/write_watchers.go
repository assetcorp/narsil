package partition

import (
	"slices"
	"sync"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/analysis"
)

type writeWatchers struct {
	mu       sync.Mutex
	watching []*analysis.Pass
}

func (p *Partition) WatchWrites(tokens *analysis.Pass) func() {
	if tokens == nil {
		return func() {}
	}
	watchers := &p.watchers
	watchers.mu.Lock()
	watchers.watching = append(watchers.watching, tokens)
	watchers.mu.Unlock()
	return func() {
		watchers.mu.Lock()
		defer watchers.mu.Unlock()
		if at := slices.Index(watchers.watching, tokens); at >= 0 {
			watchers.watching = slices.Delete(watchers.watching, at, at+1)
		}
	}
}

func (p *Partition) lendTokens(tokens *analysis.Pass) {
	if tokens == nil {
		return
	}
	watchers := &p.watchers
	watchers.mu.Lock()
	defer watchers.mu.Unlock()
	for _, watching := range watchers.watching {
		watching.Borrow(tokens)
	}
}
