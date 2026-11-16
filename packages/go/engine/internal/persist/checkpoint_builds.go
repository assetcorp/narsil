package persist

import (
	"context"
	"sync"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/metadata"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/checkpoint"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/storage"
)

type checkpointBuild struct {
	durable    *Durable
	pin        uint64
	prior      *manifest.Manifest
	meta       metadata.Metadata
	count      uint64
	since      int64
	sinceBytes int64
	settled    int64
	settledBy  int64
	stop       context.CancelFunc

	mu        sync.Mutex
	cancelled bool
	shut      bool
	written   map[string]struct{}
	staged    map[*storage.StagedFile]struct{}
}

type settledCounts struct {
	records int64
	bytes   int64
}

func (durable *Durable) closedError() error {
	return narsilerr.New(narsilerr.CodeInstanceShutDown,
		`Index "`+durable.handle.Name+`" is closed`, map[string]any{"indexName": durable.handle.Name})
}

func (durable *Durable) registerBuild(prior *manifest.Manifest, meta metadata.Metadata, count uint64, since int64,
	sinceBytes int64, stop context.CancelFunc) *checkpointBuild {
	durable.nextPin++
	build := &checkpointBuild{durable: durable, pin: durable.nextPin, prior: prior, meta: meta, count: count,
		since: since, sinceBytes: sinceBytes, settled: durable.settled.records, settledBy: durable.settled.bytes,
		stop: stop, written: map[string]struct{}{}, staged: map[*storage.StagedFile]struct{}{}}
	durable.buildsMu.Lock()
	defer durable.buildsMu.Unlock()
	if durable.builds == nil {
		durable.builds = map[*checkpointBuild]struct{}{}
	}
	durable.builds[build] = struct{}{}
	return build
}

func (durable *Durable) unregisterBuild(build *checkpointBuild) {
	durable.buildsMu.Lock()
	defer durable.buildsMu.Unlock()
	delete(durable.builds, build)
	build.stop()
	if len(durable.builds) == 0 && durable.buildsGone != nil {
		close(durable.buildsGone)
		durable.buildsGone = nil
	}
}

func (durable *Durable) awaitBuilds() {
	durable.buildsMu.Lock()
	if len(durable.builds) == 0 {
		durable.buildsMu.Unlock()
		return
	}
	if durable.buildsGone == nil {
		durable.buildsGone = make(chan struct{})
	}
	gone := durable.buildsGone
	durable.buildsMu.Unlock()
	<-gone
}

func (durable *Durable) holdCommittedGarbage(pin uint64, garbage []string) {
	durable.buildsMu.Lock()
	defer durable.buildsMu.Unlock()
	if durable.committedGarbage == nil {
		durable.committedGarbage = map[uint64][]string{}
	}
	durable.committedGarbage[pin] = garbage
}

func (durable *Durable) takeCommittedGarbage(pin uint64) []string {
	durable.buildsMu.Lock()
	defer durable.buildsMu.Unlock()
	garbage := durable.committedGarbage[pin]
	delete(durable.committedGarbage, pin)
	return garbage
}

func (durable *Durable) takeEveryCommittedGarbage() []string {
	durable.buildsMu.Lock()
	defer durable.buildsMu.Unlock()
	var garbage []string
	for pin, keys := range durable.committedGarbage {
		garbage = append(garbage, keys...)
		delete(durable.committedGarbage, pin)
	}
	return garbage
}

func (durable *Durable) removeGarbageLeftAtClose() error {
	ctx, store := context.Background(), durable.manager.store
	garbage := durable.takeEveryCommittedGarbage()
	current, err := checkpoint.ReadManifest(ctx, store, durable.handle.Name)
	if err != nil || current.Kind != checkpoint.ManifestCurrent {
		return err
	}
	return durable.removeGarbage(ctx, store, current.Manifest, garbage)
}

func (durable *Durable) buildsInFlight() []*checkpointBuild {
	durable.buildsMu.Lock()
	defer durable.buildsMu.Unlock()
	held := make([]*checkpointBuild, 0, len(durable.builds))
	for build := range durable.builds {
		held = append(held, build)
	}
	return held
}

func (build *checkpointBuild) removeFiles(ctx context.Context) []string {
	build.mu.Lock()
	defer build.mu.Unlock()
	build.cancelled = true
	for staged := range build.staged {
		staged.Abort()
	}
	clear(build.staged)
	var failed []string
	for key := range build.written {
		if err := build.durable.manager.store.Remove(context.WithoutCancel(ctx), key); err != nil {
			failed = append(failed, key)
		}
	}
	clear(build.written)
	return failed
}

func (build *checkpointBuild) writtenKeys() []string {
	build.mu.Lock()
	defer build.mu.Unlock()
	keys := make([]string, 0, len(build.written))
	for key := range build.written {
		keys = append(keys, key)
	}
	return keys
}

func (build *checkpointBuild) isCancelled() bool {
	build.mu.Lock()
	defer build.mu.Unlock()
	return build.cancelled
}

func (build *checkpointBuild) isShutDown() bool {
	build.mu.Lock()
	defer build.mu.Unlock()
	return build.shut
}

func (durable *Durable) cancelBuilds() {
	for _, build := range durable.buildsInFlight() {
		build.mu.Lock()
		build.shut = true
		build.mu.Unlock()
		build.stop()
		durable.orphanGarbage(build.removeFiles(context.Background()))
	}
}

func (durable *Durable) orphanGarbage(keys []string) {
	if len(keys) == 0 {
		return
	}
	durable.buildsMu.Lock()
	defer durable.buildsMu.Unlock()
	durable.orphaned = append(durable.orphaned, keys...)
}

func (durable *Durable) takeOrphaned() []string {
	durable.buildsMu.Lock()
	defer durable.buildsMu.Unlock()
	orphaned := durable.orphaned
	durable.orphaned = nil
	return orphaned
}

func (durable *Durable) keysThatBuildsRead() map[string]struct{} {
	read := map[string]struct{}{}
	for _, build := range durable.buildsInFlight() {
		if build.prior == nil {
			continue
		}
		for key := range checkpoint.ReferencedKeys(*build.prior) {
			read[key] = struct{}{}
		}
	}
	return read
}

func (durable *Durable) logBoundsFor(seqNos []uint64) []uint64 {
	bounds := append([]uint64(nil), seqNos...)
	for _, build := range durable.buildsInFlight() {
		for partitionID := range bounds {
			bounds[partitionID] = min(bounds[partitionID], priorSeqNoOf(build.prior, partitionID))
		}
	}
	return bounds
}

func (durable *Durable) settleCommitted(build *checkpointBuild, left int64) {
	settledSincePin := settledCounts{records: durable.settled.records - build.settled,
		bytes: durable.settled.bytes - build.settledBy}
	records := max(0, build.since-settledSincePin.records)
	documentBytes := max(0, build.sinceBytes-settledSincePin.bytes)
	covered := max(0, records-left)
	if records > 0 && covered < records {
		documentBytes = int64(float64(documentBytes) * float64(covered) / float64(records))
	}
	durable.sinceCheckpoint.Add(-covered)
	durable.bytesSinceCheckpoint.Add(-documentBytes)
	durable.settled.records += covered
	durable.settled.bytes += documentBytes
}
