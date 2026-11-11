package paged

import (
	"container/list"
	"sync"
)

type CachedKind uint8

const (
	CachedPage CachedKind = iota
	CachedList
	CachedPositions
	CachedDocumentBlock
)

type cacheKey struct {
	file  uint64
	kind  CachedKind
	entry int64
}

type cacheEntry struct {
	key   cacheKey
	value any
	bytes int64
}

type ReadCache struct {
	mutex    sync.Mutex
	capacity int64
	held     int64
	order    *list.List
	entries  map[cacheKey]*list.Element
	perFile  map[uint64]int64
	open     map[uint64]struct{}
	next     uint64
}

func NewReadCache(capacity int64) *ReadCache {
	return &ReadCache{capacity: capacity, order: list.New(), entries: map[cacheKey]*list.Element{},
		perFile: map[uint64]int64{}, open: map[uint64]struct{}{}}
}

var sharedReadCache = sync.OnceValue(func() *ReadCache { return NewReadCache(SharedReadCacheBytes) })

func SharedReadCache() *ReadCache {
	return sharedReadCache()
}

func (cache *ReadCache) Capacity() int64 {
	return cache.capacity
}

func (cache *ReadCache) Bytes() int64 {
	cache.mutex.Lock()
	defer cache.mutex.Unlock()
	return cache.held
}

func (cache *ReadCache) BytesOfFile(file uint64) int64 {
	cache.mutex.Lock()
	defer cache.mutex.Unlock()
	return cache.perFile[file]
}

func (cache *ReadCache) FileNumber() uint64 {
	cache.mutex.Lock()
	defer cache.mutex.Unlock()
	cache.next++
	cache.open[cache.next] = struct{}{}
	return cache.next
}

func (cache *ReadCache) Get(file uint64, kind CachedKind, entry int64) (any, bool) {
	cache.mutex.Lock()
	defer cache.mutex.Unlock()
	element, held := cache.entries[cacheKey{file: file, kind: kind, entry: entry}]
	if !held {
		return nil, false
	}
	cache.order.MoveToBack(element)
	return element.Value.(*cacheEntry).value, true
}

func (cache *ReadCache) dropLocked(element *list.Element) {
	held := element.Value.(*cacheEntry)
	cache.order.Remove(element)
	delete(cache.entries, held.key)
	cache.held -= held.bytes
	remaining := cache.perFile[held.key.file] - held.bytes
	if remaining <= 0 {
		delete(cache.perFile, held.key.file)
		return
	}
	cache.perFile[held.key.file] = remaining
}

func (cache *ReadCache) Put(file uint64, kind CachedKind, entry int64, value any, bytes int64) {
	if float64(bytes) > float64(cache.capacity)*LargestCachedEntryShare {
		return
	}
	cache.mutex.Lock()
	defer cache.mutex.Unlock()
	if _, open := cache.open[file]; !open {
		return
	}
	key := cacheKey{file: file, kind: kind, entry: entry}
	if existing, held := cache.entries[key]; held {
		cache.dropLocked(existing)
	}
	cache.entries[key] = cache.order.PushBack(&cacheEntry{key: key, value: value, bytes: bytes})
	cache.held += bytes
	cache.perFile[file] += bytes
	for cache.held > cache.capacity {
		oldest := cache.order.Front()
		if oldest == nil {
			return
		}
		cache.dropLocked(oldest)
	}
}

func (cache *ReadCache) ReleaseFile(file uint64) {
	cache.mutex.Lock()
	defer cache.mutex.Unlock()
	delete(cache.open, file)
	if _, held := cache.perFile[file]; !held {
		return
	}
	for element := cache.order.Front(); element != nil; {
		next := element.Next()
		if element.Value.(*cacheEntry).key.file == file {
			cache.dropLocked(element)
		}
		element = next
	}
}

func (cache *ReadCache) Clear() {
	cache.mutex.Lock()
	defer cache.mutex.Unlock()
	cache.order.Init()
	clear(cache.entries)
	clear(cache.perFile)
	cache.held = 0
}
