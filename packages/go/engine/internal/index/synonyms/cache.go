package synonyms

import (
	"container/list"
	"hash/maphash"
	"sync"
)

type cachedSynonyms struct {
	token    string
	synonyms []string
}

type cacheShard struct {
	mu      sync.Mutex
	entries map[string]*list.Element
	recency list.List
}

type synonymCache struct {
	seed   maphash.Seed
	shards [synonymCacheShards]cacheShard
}

func newSynonymCache() *synonymCache {
	cache := &synonymCache{seed: maphash.MakeSeed()}
	for at := range cache.shards {
		cache.shards[at].entries = make(map[string]*list.Element, synonymCacheEntriesPerShard)
	}
	return cache
}

func (c *synonymCache) shardOf(token string) *cacheShard {
	return &c.shards[maphash.String(c.seed, token)%synonymCacheShards]
}

func (c *synonymCache) get(token string) ([]string, bool) {
	shard := c.shardOf(token)
	shard.mu.Lock()
	defer shard.mu.Unlock()
	element, found := shard.entries[token]
	if !found {
		return nil, false
	}
	shard.recency.MoveToBack(element)
	return element.Value.(*cachedSynonyms).synonyms, true
}

func (c *synonymCache) put(token string, synonyms []string) {
	shard := c.shardOf(token)
	shard.mu.Lock()
	defer shard.mu.Unlock()
	if element, found := shard.entries[token]; found {
		shard.recency.MoveToBack(element)
		return
	}
	if len(shard.entries) >= synonymCacheEntriesPerShard {
		oldest := shard.recency.Front()
		delete(shard.entries, oldest.Value.(*cachedSynonyms).token)
		shard.recency.Remove(oldest)
	}
	shard.entries[token] = shard.recency.PushBack(&cachedSynonyms{token: token, synonyms: synonyms})
}
