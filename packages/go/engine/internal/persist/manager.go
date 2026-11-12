package persist

import (
	"context"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/metadata"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/checkpoint"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/storage"
)

type Mode uint8

const (
	ModeSync Mode = iota
	ModeAsync
)

type Settings struct {
	Directory                   string
	Adapter                     storage.Adapter
	Mode                        Mode
	FlushInterval               time.Duration
	CheckpointInterval          time.Duration
	CheckpointMutationThreshold int64
	SegmentMaxBytes             int64
	CompactionThreshold         int
	RewriteBytesPerCheckpoint   int64
	OnFatal                     func(error)
}

type Hooks struct {
	CreateIndex     func(ctx context.Context, meta metadata.Metadata) (*Handle, error)
	OnLayoutUpgrade func(event LayoutUpgradeEvent)
}

type Manager struct {
	settings  Settings
	hooks     Hooks
	directory *storage.Directory
	store     checkpoint.Store
	lock      *storage.DirectoryLock
	identity  string
	sizes     *storedSizes

	mutex   sync.Mutex
	indexes map[string]*Durable
	closed  bool

	fatalMutex sync.Mutex
	fatal      error

	stop    chan struct{}
	wake    chan struct{}
	stopped sync.WaitGroup
}

func Open(ctx context.Context, settings Settings, hooks Hooks) (*Manager, error) {
	if hooks.CreateIndex == nil {
		return nil, narsilerr.New(narsilerr.CodeConfigInvalid, "Durability needs the index creation hooks", nil)
	}
	if settings.FlushInterval <= 0 {
		settings.FlushInterval = DefaultAsyncFlushInterval
	}
	if settings.CheckpointMutationThreshold == 0 {
		settings.CheckpointMutationThreshold = DefaultCheckpointMutationThreshold
	}
	if settings.CompactionThreshold <= 0 || settings.CompactionThreshold > manifest.MaxSegmentsPerPartition {
		settings.CompactionThreshold = DefaultCompactionThreshold
	}
	if settings.RewriteBytesPerCheckpoint <= 0 {
		settings.RewriteBytesPerCheckpoint = DefaultRewriteBytesPerCheckpoint
	}
	manager := &Manager{settings: settings, hooks: hooks, indexes: map[string]*Durable{},
		stop: make(chan struct{}), wake: make(chan struct{}, 1), sizes: newStoredSizes()}
	switch {
	case settings.Directory != "":
		directory, err := storage.OpenDirectory(settings.Directory)
		if err != nil {
			return nil, err
		}
		lock, err := directory.Lock()
		if err != nil {
			return nil, err
		}
		identity, _, err := directory.Identity()
		if err != nil {
			lock.Release()
			return nil, err
		}
		directory.TrackSizes(manager.sizes)
		manager.directory, manager.lock, manager.identity = directory, lock, identity
		manager.store = checkpoint.DirectoryStore{Directory: directory}
	case settings.Adapter != nil:
		manager.store = checkpoint.AdapterStore{Adapter: settings.Adapter}
	default:
		return nil, narsilerr.New(narsilerr.CodeConfigInvalid,
			"Durability needs a directory for the write-ahead log or a persistence adapter", nil)
	}
	if err := ctx.Err(); err != nil {
		manager.release()
		return nil, err
	}
	manager.stopped.Add(1)
	go manager.background()
	return manager, nil
}

func (manager *Manager) logged() bool {
	return manager.directory != nil
}

func (manager *Manager) Store() checkpoint.Store {
	return manager.store
}

func (manager *Manager) Fatal() error {
	manager.fatalMutex.Lock()
	defer manager.fatalMutex.Unlock()
	return manager.fatal
}

func (manager *Manager) markFatal(err error) {
	manager.fatalMutex.Lock()
	first := manager.fatal == nil
	if first {
		manager.fatal = err
	}
	manager.fatalMutex.Unlock()
	if first && manager.settings.OnFatal != nil {
		manager.settings.OnFatal(err)
	}
}

func (manager *Manager) verifyDirectory() error {
	if manager.directory == nil {
		return nil
	}
	identity, present, err := manager.directory.Identity()
	if err == nil && present && identity == manager.identity && manager.lock.Holds() {
		return nil
	}
	failure := narsilerr.New(narsilerr.CodePersistenceSaveFailed,
		`The durability directory "`+manager.directory.Root()+
			`" was moved, replaced, or unlocked while the engine wrote to it, so no further write is durable`,
		map[string]any{"directory": manager.directory.Root()})
	manager.markFatal(failure)
	return failure
}

func (manager *Manager) background() {
	defer manager.stopped.Done()
	identity := time.NewTicker(DirectoryIdentityCheckInterval)
	defer identity.Stop()
	flush := time.NewTicker(manager.settings.FlushInterval)
	defer flush.Stop()
	interval := manager.settings.CheckpointInterval
	if interval <= 0 {
		interval = DefaultCheckpointInterval
	}
	checkpoints := time.NewTicker(interval)
	defer checkpoints.Stop()
	for {
		select {
		case <-manager.stop:
			return
		case <-identity.C:
			if manager.Fatal() == nil {
				_ = manager.verifyDirectory()
			}
		case <-flush.C:
			if manager.settings.Mode == ModeAsync {
				manager.flushAll()
			}
		case <-checkpoints.C:
			if manager.settings.CheckpointInterval >= 0 {
				manager.checkpointAll(false)
			}
		case <-manager.wake:
			manager.checkpointAll(true)
		}
	}
}

func (manager *Manager) snapshotIndexes() []*Durable {
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	names := make([]string, 0, len(manager.indexes))
	for name := range manager.indexes {
		names = append(names, name)
	}
	sort.Strings(names)
	held := make([]*Durable, len(names))
	for at, name := range names {
		held[at] = manager.indexes[name]
	}
	return held
}

func (manager *Manager) flushAll() {
	for _, durable := range manager.snapshotIndexes() {
		if err := durable.flush(); err != nil {
			manager.markFatal(err)
		}
	}
}

func (manager *Manager) checkpointAll(onlyDue bool) {
	for _, durable := range manager.snapshotIndexes() {
		if onlyDue && !durable.checkpointDue(manager.settings.CheckpointMutationThreshold) {
			continue
		}
		if len(durable.failedPartitionIDs()) > 0 || durable.closed.Load() {
			continue
		}
		err := durable.Checkpoint(context.Background())
		if err != nil && !durable.closed.Load() && narsilerr.CodeOf(err) != narsilerr.CodeInstanceShutDown {
			manager.markFatal(err)
		}
	}
}

func (manager *Manager) noteMutations(durable *Durable, count int) {
	durable.sinceCheckpoint.Add(int64(count))
	if durable.checkpointDue(manager.settings.CheckpointMutationThreshold) {
		select {
		case manager.wake <- struct{}{}:
		default:
		}
	}
}

func (manager *Manager) Get(name string) (*Durable, bool) {
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	durable, found := manager.indexes[name]
	return durable, found
}

func (manager *Manager) register(durable *Durable) error {
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	if manager.closed {
		return narsilerr.New(narsilerr.CodeInstanceShutDown, "The durability manager is closed", nil)
	}
	if _, taken := manager.indexes[durable.handle.Name]; taken {
		return narsilerr.New(narsilerr.CodeIndexAlreadyExists,
			`Index "`+durable.handle.Name+`" is already open`, map[string]any{"indexName": durable.handle.Name})
	}
	manager.indexes[durable.handle.Name] = durable
	return nil
}

func (manager *Manager) unregister(name string) {
	manager.mutex.Lock()
	delete(manager.indexes, name)
	manager.mutex.Unlock()
}

func (manager *Manager) removeIndexKeys(ctx context.Context, name string) error {
	keys, err := manager.store.List(ctx, name+"/")
	if err != nil {
		return err
	}
	for _, key := range keys {
		if !strings.HasPrefix(key, name+"/") {
			continue
		}
		if err := manager.store.Remove(ctx, key); err != nil {
			return err
		}
	}
	return nil
}

func (manager *Manager) release() {
	if manager.lock != nil {
		manager.lock.Release()
	}
}

func (manager *Manager) Close(ctx context.Context) error {
	manager.mutex.Lock()
	if manager.closed {
		manager.mutex.Unlock()
		return nil
	}
	manager.closed = true
	manager.mutex.Unlock()
	close(manager.stop)
	manager.stopped.Wait()
	var first error
	for _, durable := range manager.snapshotIndexes() {
		if err := durable.close(); err != nil && first == nil {
			first = err
		}
	}
	manager.mutex.Lock()
	manager.indexes = map[string]*Durable{}
	manager.mutex.Unlock()
	manager.release()
	if err := ctx.Err(); err != nil && first == nil {
		first = err
	}
	return first
}
