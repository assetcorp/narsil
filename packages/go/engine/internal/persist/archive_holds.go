package persist

import (
	"context"
	"sync"

	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/checkpoint"
)

type archiveHold struct {
	keys map[string]struct{}
}

type archiveHolds struct {
	mutex sync.Mutex
	held  map[string]map[*archiveHold]struct{}
}

func (holds *archiveHolds) hold(name string) (*archiveHold, func()) {
	hold := &archiveHold{}
	holds.mutex.Lock()
	defer holds.mutex.Unlock()
	if holds.held == nil {
		holds.held = map[string]map[*archiveHold]struct{}{}
	}
	if holds.held[name] == nil {
		holds.held[name] = map[*archiveHold]struct{}{}
	}
	holds.held[name][hold] = struct{}{}
	var once sync.Once
	return hold, func() { once.Do(func() { holds.release(name, hold) }) }
}

func (holds *archiveHolds) release(name string, hold *archiveHold) {
	holds.mutex.Lock()
	defer holds.mutex.Unlock()
	delete(holds.held[name], hold)
	if len(holds.held[name]) == 0 {
		delete(holds.held, name)
	}
}

func (holds *archiveHolds) narrow(hold *archiveHold, keys []string) {
	listed := make(map[string]struct{}, len(keys))
	for _, key := range keys {
		listed[key] = struct{}{}
	}
	holds.mutex.Lock()
	defer holds.mutex.Unlock()
	hold.keys = listed
}

func (holds *archiveHolds) split(name string, keys []string) (free []string, held []string) {
	holds.mutex.Lock()
	defer holds.mutex.Unlock()
	holders := holds.held[name]
	for _, key := range keys {
		if holdsKey(holders, key) {
			held = append(held, key)
			continue
		}
		free = append(free, key)
	}
	return free, held
}

func holdsKey(holders map[*archiveHold]struct{}, key string) bool {
	for hold := range holders {
		if hold.keys == nil {
			return true
		}
		if _, listed := hold.keys[key]; listed {
			return true
		}
	}
	return false
}

func (holds *archiveHolds) keysOf(name string) (keys []string, everything bool) {
	holds.mutex.Lock()
	defer holds.mutex.Unlock()
	for hold := range holds.held[name] {
		if hold.keys == nil {
			return nil, true
		}
		for key := range hold.keys {
			keys = append(keys, key)
		}
	}
	return keys, false
}

func (manager *Manager) reclaimUnlisted(ctx context.Context, store checkpoint.Store, name string,
	referenced map[string]struct{}) error {
	held, everything := manager.archives.keysOf(name)
	if everything {
		return nil
	}
	for _, key := range held {
		referenced[key] = struct{}{}
	}
	return checkpoint.ReclaimUnlisted(ctx, store, name, referenced)
}
