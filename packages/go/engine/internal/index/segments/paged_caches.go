package segments

import (
	"sync"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/paged"
)

const pageSlotMetadataBytes = 3*8 + 2*4

const smallestPageCacheSlots = 1

func pageCacheSlots(capacityBytes float64) int {
	return max(smallestPageCacheSlots, int(capacityBytes/(core.PageSlotBytes+pageSlotMetadataBytes)))
}

func nativePageCacheBytes() float64 {
	return paged.SharedReadCacheBytes * paged.NativePageCacheShare
}

func NewRemovalPageCache() (*core.PageCache, error) {
	return core.NewPageCache(pageCacheSlots(nativePageCacheBytes()))
}

func NewMergePageCache() (*core.PageCache, error) {
	return core.NewPageCache(pageCacheSlots(paged.MergeReadCacheBytes * paged.NativePageCacheShare))
}

type readPageLease struct {
	pages    *core.PageCache
	retained bool
}

type readPageLeases struct {
	mutex    sync.Mutex
	idle     []*core.PageCache
	retained int
}

var pagedReadLeases readPageLeases

func (l *readPageLeases) acquire() (readPageLease, error) {
	l.mutex.Lock()
	if last := len(l.idle) - 1; last >= 0 {
		pages := l.idle[last]
		l.idle = l.idle[:last]
		l.mutex.Unlock()
		return readPageLease{pages: pages, retained: true}, nil
	}
	retained := l.retained < paged.NativeAsyncPageCaches
	if retained {
		l.retained++
	}
	l.mutex.Unlock()
	slots := smallestPageCacheSlots
	if retained {
		slots = pageCacheSlots(nativePageCacheBytes() / paged.NativeAsyncPageCaches)
	}
	pages, err := core.NewPageCache(slots)
	if err != nil {
		if retained {
			l.mutex.Lock()
			l.retained--
			l.mutex.Unlock()
		}
		return readPageLease{}, err
	}
	return readPageLease{pages: pages, retained: retained}, nil
}

func (l *readPageLeases) release(lease readPageLease) {
	if !lease.retained {
		return
	}
	l.mutex.Lock()
	l.idle = append(l.idle, lease.pages)
	l.mutex.Unlock()
}
