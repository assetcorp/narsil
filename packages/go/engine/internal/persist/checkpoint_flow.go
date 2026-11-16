package persist

import (
	"context"
	"sort"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/checkpoint"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/writeahead"
)

type checkpointPin struct {
	build     *checkpointBuild
	caller    context.Context
	ctx       context.Context
	handle    *Handle
	held      capture
	logged    bool
	pagedText bool
	locked    bool
	epoch     uint64
}

type checkpointOutcome struct {
	written    manifest.Manifest
	left       uint64
	superseded bool
	repin      bool
	adoptions  []pendingAdoption
	garbage    []string
}

func (handle *Handle) pinned() *Handle {
	return &Handle{Name: handle.Name, Index: handle.Index, Schema: handle.Schema, Vectors: handle.Vectors,
		Metadata: handle.Metadata, NewDetachedIndex: handle.NewDetachedIndex, SyncHistoryMoved: handle.SyncHistoryMoved,
		RecordsPrevious: handle.RecordsPrevious}
}

func (durable *Durable) checkpointWith(ctx context.Context, options checkpointOptions) (manifest.Manifest, error) {
	durable.stall.begin()
	defer durable.stall.end()
	for {
		outcome, err := durable.boundedCheckpoint(ctx, options)
		if err != nil {
			return outcome.written, err
		}
		if !outcome.repin && (outcome.left == 0 || durable.closed.Load() || ctx.Err() != nil) {
			return outcome.written, nil
		}
		if err := ctx.Err(); err != nil {
			return outcome.written, err
		}
		options.prior = nil
	}
}

func (durable *Durable) boundedCheckpoint(ctx context.Context, options checkpointOptions) (checkpointOutcome, error) {
	pin, err := durable.pinCheckpoint(ctx, options)
	if err != nil {
		return checkpointOutcome{}, err
	}
	defer func() { pin.held.release() }()
	written, built := durable.buildPinned(pin)
	outcome, err := durable.commitPinned(pin, written, built)
	if err != nil || outcome.superseded || outcome.repin {
		return outcome, err
	}
	if len(outcome.adoptions) > 0 && durable.stillCommitted(pin) {
		if err := durable.adoptAll(context.WithoutCancel(ctx), durable.manager.store, outcome.adoptions); err != nil {
			return outcome, err
		}
	}
	return outcome, durable.removePinnedGarbage(pin, outcome.garbage)
}

func (durable *Durable) lockFor(pin *checkpointPin) (func(), error) {
	if pin.locked {
		return func() {}, nil
	}
	if err := durable.checkpointMutex.LockContext(pin.caller); err != nil {
		return nil, err
	}
	return durable.checkpointMutex.Unlock, nil
}

func (durable *Durable) pinCheckpoint(ctx context.Context, options checkpointOptions) (*checkpointPin, error) {
	if !options.locked {
		if err := durable.checkpointMutex.LockContext(ctx); err != nil {
			return nil, err
		}
		defer durable.checkpointMutex.Unlock()
	}
	store, logged := durable.manager.store, durable.manager.logged()
	if err := durable.prepareCheckpoint(ctx, logged); err != nil {
		return nil, err
	}
	for _, field := range durable.handle.vectorFields() {
		if err := field.UntilColdLoaded(ctx); err != nil {
			return nil, err
		}
	}
	prior := options.prior
	if prior == nil {
		read, err := durable.priorManifest(ctx, store)
		if err != nil {
			return nil, err
		}
		prior = read
	}
	if err := durable.seedIDs(); err != nil {
		return nil, err
	}
	since, sinceBytes := durable.sinceCheckpoint.Load(), durable.bytesSinceCheckpoint.Load()
	options.pagedText = durable.textStoredOnDisk()
	held, err := durable.captureLocked(ctx, prior, logged, options)
	if err != nil {
		return nil, err
	}
	meta, err := durable.handle.metadata(held.count)
	if err != nil {
		held.release()
		return nil, err
	}
	buildCtx, stop := context.WithCancel(ctx)
	build := durable.registerBuild(prior, meta, held.count, since, sinceBytes, stop)
	return &checkpointPin{build: build, caller: ctx, ctx: buildCtx, handle: durable.handle.pinned(), held: held,
		logged: logged, pagedText: options.pagedText, locked: options.locked, epoch: durable.layoutEpoch}, nil
}

func (durable *Durable) buildPinned(pin *checkpointPin) (checkpoint.Written, error) {
	ctx, held, handle, prior := pin.ctx, &pin.held, pin.handle, pin.build.prior
	store := buildStore{base: durable.manager.store, build: pin.build}
	if err := held.writeFrozenPartitions(handle); err != nil {
		return checkpoint.Written{}, err
	}
	if err := durable.buildLoggedPartitions(ctx, store, handle, prior, held, pin.pagedText); err != nil {
		return checkpoint.Written{}, err
	}
	written, err := checkpoint.WriteFiles(ctx, store, checkpointInput(handle, pin.build.meta, prior, *held))
	if err != nil {
		return written, err
	}
	rewritten, err := compactWritten(ctx, store, handle, prior, &written, durable.manager.settings.checkpointLimits(),
		pin.pagedText, held.live)
	held.rewritten = rewritten
	return written, err
}

func (durable *Durable) discardBuild(pin *checkpointPin, cause error) (checkpointOutcome, error) {
	durable.orphanGarbage(pin.build.removeFiles(pin.caller))
	switch {
	case durable.committedPin > pin.build.pin:
		return checkpointOutcome{left: pin.held.left, superseded: true}, nil
	case pin.build.isShutDown() || durable.closed.Load():
		return checkpointOutcome{}, durable.closedError()
	case pin.epoch != durable.layoutEpoch:
		return checkpointOutcome{repin: true}, nil
	case cause != nil:
		return checkpointOutcome{}, cause
	}
	return checkpointOutcome{}, durable.closedError()
}

func (durable *Durable) commitPinned(pin *checkpointPin, written checkpoint.Written, built error) (checkpointOutcome,
	error) {
	unlock, err := durable.lockFor(pin)
	if err != nil {
		durable.unregisterBuild(pin.build)
		durable.orphanGarbage(pin.build.removeFiles(pin.caller))
		return checkpointOutcome{}, err
	}
	defer unlock()
	build := pin.build
	durable.unregisterBuild(build)
	if built != nil || durable.committedPin > build.pin || pin.epoch != durable.layoutEpoch ||
		build.isCancelled() || durable.closed.Load() {
		return durable.discardBuild(pin, built)
	}
	ctx, store := context.WithoutCancel(pin.caller), durable.manager.store
	current, err := checkpoint.ReadManifest(ctx, store, durable.handle.Name)
	if err != nil {
		return durable.discardBuild(pin, err)
	}
	garbage := garbageOf(written, build, current, build.prior)
	if err := checkpoint.CommitManifest(ctx, store, durable.handle.Name, written); err != nil {
		return checkpointOutcome{}, err
	}
	durable.committedPin = build.pin
	outcome := checkpointOutcome{written: written.Manifest, left: pin.held.left, garbage: garbage}
	durable.manager.sizes.recordSaved(durable.handle.Name, savedSizeOf(written.Manifest))
	if err := written.Record(ctx); err != nil {
		return outcome, err
	}
	outcome.adoptions = durable.adoptionsOf(written.Manifest, pin.held)
	durable.noteClearsCovered(pin.held)
	if err := durable.writeMetadata(ctx, build.count); err != nil {
		return outcome, err
	}
	durable.settleCommitted(build, int64(pin.held.left))
	if !pin.logged {
		return outcome, nil
	}
	if err := durable.truncateCovered(durable.logBoundsFor(pin.held.seqNos)); err != nil {
		return outcome, err
	}
	return outcome, writeahead.RemoveBeyondCount(durable.manager.directory, durable.handle.Name,
		len(durable.partitions))
}

func (durable *Durable) stillCommitted(pin *checkpointPin) bool {
	unlock, err := durable.lockFor(pin)
	if err != nil {
		return false
	}
	defer unlock()
	return durable.committedPin == pin.build.pin && pin.epoch == durable.layoutEpoch && !durable.closed.Load()
}

func (durable *Durable) removePinnedGarbage(pin *checkpointPin, garbage []string) error {
	unlock, err := durable.lockFor(pin)
	if err != nil {
		durable.orphanGarbage(garbage)
		return nil
	}
	defer unlock()
	if durable.closed.Load() {
		return nil
	}
	ctx, store := context.WithoutCancel(pin.caller), durable.manager.store
	current, err := checkpoint.ReadManifest(ctx, store, durable.handle.Name)
	if err != nil {
		return err
	}
	listed := manifest.Manifest{}
	if current.Kind == checkpoint.ManifestCurrent {
		listed = current.Manifest
	}
	return durable.removeGarbage(ctx, store, listed, garbage)
}

func garbageOf(written checkpoint.Written, build *checkpointBuild, current checkpoint.Read,
	prior *manifest.Manifest) []string {
	kept := checkpoint.ReferencedKeys(written.Manifest)
	candidates := map[string]struct{}{}
	add := func(key string) {
		if _, listed := kept[key]; !listed {
			candidates[key] = struct{}{}
		}
	}
	for _, key := range written.Garbage {
		add(key)
	}
	for _, key := range build.writtenKeys() {
		add(key)
	}
	if prior != nil {
		for key := range checkpoint.ReferencedKeys(*prior) {
			add(key)
		}
	}
	if current.Kind == checkpoint.ManifestCurrent {
		for key := range checkpoint.ReferencedKeys(current.Manifest) {
			add(key)
		}
	}
	garbage := make([]string, 0, len(candidates))
	for key := range candidates {
		garbage = append(garbage, key)
	}
	sort.Strings(garbage)
	return garbage
}
