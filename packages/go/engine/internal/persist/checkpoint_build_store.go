package persist

import (
	"context"
	"io"
	"sync"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/checkpoint"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/storage"
)

type checkpointIDs struct {
	mu       sync.Mutex
	segments map[uint32]uint64
	files    map[string]uint64
	graphs   map[string]uint64
}

func reserveFrom[K comparable](mu *sync.Mutex, next *map[K]uint64, key K, floor uint64) uint64 {
	mu.Lock()
	defer mu.Unlock()
	if *next == nil {
		*next = map[K]uint64{}
	}
	id := max((*next)[key], floor)
	(*next)[key] = id + 1
	return id
}

func raiseTo[K comparable](next *map[K]uint64, key K, floor uint64) {
	if *next == nil {
		*next = map[K]uint64{}
	}
	(*next)[key] = max((*next)[key], floor)
}

func (ids *checkpointIDs) raise(listed manifest.Manifest) {
	ids.mu.Lock()
	defer ids.mu.Unlock()
	for _, entry := range listed.Partitions {
		raiseTo(&ids.segments, entry.PartitionID, entry.NextSegmentID)
	}
	for _, field := range listed.Vectors {
		raiseTo(&ids.files, field.FieldPath, field.NextFileID)
		raiseTo(&ids.graphs, field.FieldPath, field.GraphGeneration+1)
	}
}

func (durable *Durable) seedIDs() error {
	if durable.idsSeeded {
		return nil
	}
	published, err := durable.publishedIfActive()
	if err != nil {
		return err
	}
	if published != nil {
		durable.ids.raise(published.Manifest)
	}
	durable.idsSeeded = true
	return nil
}

type buildStore struct {
	base  checkpoint.Store
	build *checkpointBuild
}

func (store buildStore) ids() *checkpointIDs {
	return &store.build.durable.ids
}

func (store buildStore) ReserveSegmentID(partitionID uint32, floor uint64) uint64 {
	ids := store.ids()
	return reserveFrom(&ids.mu, &ids.segments, partitionID, floor)
}

func (store buildStore) ReserveVectorFileID(fieldPath string, floor uint64) uint64 {
	ids := store.ids()
	return reserveFrom(&ids.mu, &ids.files, fieldPath, floor)
}

func (store buildStore) ReserveGraphGeneration(fieldPath string, floor uint64) uint64 {
	ids := store.ids()
	return reserveFrom(&ids.mu, &ids.graphs, fieldPath, floor)
}

func (store buildStore) Read(ctx context.Context, key string) ([]byte, bool, error) {
	return store.base.Read(ctx, key)
}

func (store buildStore) Size(ctx context.Context, key string) (int64, bool, error) {
	return store.base.Size(ctx, key)
}

func (store buildStore) List(ctx context.Context, prefix string) ([]string, error) {
	return store.base.List(ctx, prefix)
}

func (store buildStore) PathOf(key string) (string, bool) {
	return store.base.PathOf(key)
}

func (store buildStore) Write(ctx context.Context, key string, chunks ...[]byte) error {
	build := store.build
	build.mu.Lock()
	defer build.mu.Unlock()
	if build.cancelled {
		return build.durable.closedError()
	}
	build.written[key] = struct{}{}
	return store.base.Write(ctx, key, chunks...)
}

func (store buildStore) Remove(ctx context.Context, key string) error {
	build := store.build
	build.mu.Lock()
	defer build.mu.Unlock()
	delete(build.written, key)
	return store.base.Remove(ctx, key)
}

func (store buildStore) WriteStream(ctx context.Context, key string, write func(io.Writer) error) error {
	directory, held := store.base.(checkpoint.DirectoryStore)
	if !held {
		return narsilerr.New(narsilerr.CodePersistenceSaveFailed,
			`Index "`+store.build.durable.handle.Name+`" streams its checkpoint only into a durable directory`,
			map[string]any{"indexName": store.build.durable.handle.Name})
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	build := store.build
	if build.isCancelled() {
		return build.durable.closedError()
	}
	staged, err := directory.Directory.Stage(key)
	if err != nil {
		return err
	}
	if !build.holdStaged(staged) {
		return build.durable.closedError()
	}
	filled := staged.Fill(write)
	return build.finishStaged(key, staged, filled)
}

func (build *checkpointBuild) holdStaged(staged *storage.StagedFile) bool {
	build.mu.Lock()
	defer build.mu.Unlock()
	if build.cancelled {
		staged.Abort()
		return false
	}
	build.staged[staged] = struct{}{}
	return true
}

func (build *checkpointBuild) finishStaged(key string, staged *storage.StagedFile, filled error) error {
	build.mu.Lock()
	defer build.mu.Unlock()
	delete(build.staged, staged)
	if build.cancelled {
		staged.Abort()
		return build.durable.closedError()
	}
	if filled != nil {
		staged.Abort()
		return filled
	}
	if err := staged.Commit(); err != nil {
		return err
	}
	build.written[key] = struct{}{}
	return nil
}
