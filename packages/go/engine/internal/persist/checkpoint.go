package persist

import (
	"context"
	"sort"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/metadata"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partition"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/checkpoint"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/writeahead"
	"github.com/assetcorp/narsil/packages/go/engine/internal/vector"
)

type capture struct {
	seqNos     []uint64
	whole      []bool
	logged     []bool
	left       uint64
	vectors    []checkpoint.VectorCapture
	partitions []checkpoint.PartitionCapture
	selections []*heldSelections
	frozen     []*index.Reading
	changes    []*partition.ChangeLog
	tracked    *index.Index
}

func (held capture) release() {
	held.stopTracking()
	for _, field := range held.vectors {
		field.Plan.Release()
	}
	for _, selections := range held.selections {
		selections.release()
	}
	for partitionID := range held.frozen {
		held.releaseFrozen(partitionID)
	}
}

func (held capture) releaseFrozen(partitionID int) {
	if reading := held.frozen[partitionID]; reading != nil {
		held.frozen[partitionID] = nil
		reading.Release()
	}
}

func (durable *Durable) priorManifest(ctx context.Context, store checkpoint.Store) (*manifest.Manifest, error) {
	read, err := checkpoint.ReadManifest(ctx, store, durable.handle.Name)
	if err != nil {
		return nil, err
	}
	switch read.Kind {
	case checkpoint.ManifestCurrent:
		return &read.Manifest, nil
	case checkpoint.ManifestEarlier:
		return nil, narsilerr.New(narsilerr.CodePersistenceSaveFailed,
			`Index "`+durable.handle.Name+`" still holds the layout of an earlier release, which recovery upgrades before any checkpoint`,
			map[string]any{"indexName": durable.handle.Name})
	}
	return nil, nil
}

func (handle *Handle) vectorFieldPaths() []string {
	paths := make([]string, 0, len(handle.Vectors))
	for path := range handle.Vectors {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	return paths
}

func (handle *Handle) vectorFields() []*vector.Field {
	fields := make([]*vector.Field, 0, len(handle.Vectors))
	for _, path := range handle.vectorFieldPaths() {
		fields = append(fields, handle.Vectors[path])
	}
	return fields
}

func planVectors(ctx context.Context, handle *Handle, prior *manifest.Manifest, pinsRetired bool) (
	[]checkpoint.VectorCapture, error) {
	var planned []checkpoint.VectorCapture
	for _, path := range handle.vectorFieldPaths() {
		request := vector.CheckpointPlanRequest{PinsRetiredVectors: pinsRetired}
		if prior != nil {
			for _, listed := range prior.Vectors {
				if listed.FieldPath != path {
					continue
				}
				request.Listed = true
				for _, file := range listed.Files {
					request.ListedKeys = append(request.ListedKeys, file.File.Key)
				}
			}
		}
		plan, err := handle.Vectors[path].PlanCheckpoint(ctx, request)
		if err != nil {
			capture{vectors: planned}.release()
			return nil, err
		}
		planned = append(planned, checkpoint.VectorCapture{FieldPath: path, Field: handle.Vectors[path], Plan: plan})
	}
	return planned, nil
}

func partitionUnchanged(prior *manifest.Manifest, partitionID int, seqNo uint64) bool {
	if prior == nil {
		return false
	}
	for _, entry := range prior.Partitions {
		if entry.PartitionID == uint32(partitionID) {
			return prior.LastSeqNo(uint32(partitionID)) == seqNo
		}
	}
	return false
}

func segmentWriteRequestOf(handle *Handle) segmentWriteRequest {
	return segmentWriteRequest{schema: flatSchema(handle), schemaOrder: schemaOrderOf(handle)}
}

func (held *capture) writeFrozenPartitions(handle *Handle) error {
	request := segmentWriteRequestOf(handle)
	for partitionID, reading := range held.frozen {
		if reading == nil {
			continue
		}
		files, err := writeSegmentsOf(reading.Snapshots[partitionID].Selections(), request)
		held.releaseFrozen(partitionID)
		if err != nil {
			return err
		}
		held.partitions[partitionID].Segments = files
	}
	return nil
}

func (held *capture) freezeWholePartitions(ctx context.Context, handle *Handle, store checkpoint.Store,
	pagedText bool) error {
	request := segmentWriteRequestOf(handle)
	held.partitions = make([]checkpoint.PartitionCapture, len(held.seqNos))
	held.frozen = make([]*index.Reading, len(held.seqNos))
	for partitionID, seqNo := range held.seqNos {
		partition := &held.partitions[partitionID]
		partition.Checkpoint = manifest.PartitionCheckpoint{PartitionID: uint32(partitionID), LastSeqNo: seqNo,
			PrimaryTerm: SingleNodePrimaryTerm}
		if !held.whole[partitionID] {
			continue
		}
		partition.Rewritten = true
		if !pagedText {
			reading, err := freezePartition(ctx, handle.Index, partitionID)
			if err != nil {
				return err
			}
			held.frozen[partitionID] = reading
			continue
		}
		selections, err := holdPartitionSelections(ctx, handle.Index, partitionID)
		if err != nil {
			return err
		}
		held.selections = append(held.selections, selections)
		partition.Stream = func(ctx context.Context, entry *manifest.PartitionEntry) error {
			return selections.stream(ctx, store, handle.Name, entry, request)
		}
	}
	return nil
}

func flatSchema(handle *Handle) map[string]string {
	flat := map[string]string{}
	if handle.Schema == nil {
		return flat
	}
	for path, fieldType := range handle.Schema.Flatten() {
		flat[path] = string(fieldType)
	}
	return flat
}

func schemaOrderOf(handle *Handle) []string {
	if handle.Schema == nil {
		return nil
	}
	return handle.Schema.FieldOrder()
}

func checkpointInput(handle *Handle, meta metadata.Metadata, prior *manifest.Manifest, held capture) checkpoint.Input {
	input := checkpoint.Input{IndexName: handle.Name, Schema: flatSchema(handle), SchemaOrder: schemaOrderOf(handle),
		Language: meta.Language, Prior: prior, Partitions: held.partitions, Vectors: held.vectors}
	if generation, set := meta.AnalysisGeneration.Get(); set {
		input.AnalysisGeneration = generation
	}
	return input
}

type checkpointOptions struct {
	consistent     bool
	everyPartition bool
	prior          *manifest.Manifest
	pagedText      bool
}

func (durable *Durable) captureLocked(ctx context.Context, prior *manifest.Manifest, logged bool,
	options checkpointOptions) (held capture, err error) {
	consistent := options.consistent
	held = capture{seqNos: make([]uint64, len(durable.partitions))}
	for _, log := range durable.partitions {
		log.mutex.Lock()
	}
	defer func() {
		for _, log := range durable.partitions {
			log.mutex.Unlock()
		}
		if err != nil {
			held.stopTracking()
		}
	}()
	for _, log := range durable.partitions {
		if log.failed != nil {
			return held, log.failed
		}
	}
	if options.pagedText {
		if err := held.trackChanges(durable.handle); err != nil {
			return held, err
		}
	}
	for partitionID, log := range durable.partitions {
		held.seqNos[partitionID] = log.applied
	}
	durable.planPartitions(prior, logged, options, &held)
	vectors, err := planVectors(ctx, durable.handle, prior, consistent)
	if err != nil {
		return held, err
	}
	held.vectors = vectors
	if err := held.freezeWholePartitions(ctx, durable.handle, durable.manager.store, options.pagedText); err != nil {
		held.release()
		return held, err
	}
	if consistent {
		if err := held.writeFrozenPartitions(durable.handle); err != nil {
			held.release()
			return held, err
		}
	}
	if logged {
		for _, log := range durable.partitions {
			if err := log.writer.RollForCheckpoint(); err != nil {
				held.release()
				return held, durable.failPartition(log, err)
			}
		}
	}
	return held, nil
}

func (durable *Durable) Checkpoint(ctx context.Context) error {
	_, err := durable.checkpointWith(ctx, checkpointOptions{})
	return err
}

func (durable *Durable) CheckpointFromMemory(ctx context.Context) error {
	_, err := durable.checkpointWith(ctx, checkpointOptions{everyPartition: true})
	return err
}

func (durable *Durable) checkpoint(ctx context.Context, consistent bool) error {
	_, err := durable.checkpointWith(ctx, checkpointOptions{consistent: consistent})
	return err
}

func (durable *Durable) prepareCheckpoint(logged bool) error {
	if durable.closed.Load() {
		return narsilerr.New(narsilerr.CodeInstanceShutDown,
			`Index "`+durable.handle.Name+`" is closed`, map[string]any{"indexName": durable.handle.Name})
	}
	if err := durable.refuseFailedPartitions(); err != nil {
		return err
	}
	if err := durable.manager.Fatal(); err != nil {
		return err
	}
	if !logged {
		return nil
	}
	if err := durable.manager.verifyDirectory(); err != nil {
		return err
	}
	for _, log := range durable.partitions {
		if err := log.writer.PrepareCheckpointRoll(); err != nil {
			return err
		}
	}
	return nil
}

func (durable *Durable) checkpointWith(ctx context.Context, options checkpointOptions) (manifest.Manifest, error) {
	durable.checkpointMutex.Lock()
	defer durable.checkpointMutex.Unlock()
	durable.stall.begin()
	defer durable.stall.end()
	for {
		written, left, err := durable.boundedCheckpoint(ctx, options)
		if err != nil || left == 0 || durable.closed.Load() || ctx.Err() != nil {
			return written, err
		}
		options.prior = nil
	}
}

func (durable *Durable) boundedCheckpoint(ctx context.Context, options checkpointOptions) (manifest.Manifest, uint64,
	error) {
	store, logged := durable.manager.store, durable.manager.logged()
	if err := durable.prepareCheckpoint(logged); err != nil {
		return manifest.Manifest{}, 0, err
	}
	for _, field := range durable.handle.vectorFields() {
		if err := field.UntilColdLoaded(ctx); err != nil {
			return manifest.Manifest{}, 0, err
		}
	}
	prior := options.prior
	if prior == nil {
		read, err := durable.priorManifest(ctx, store)
		if err != nil {
			return manifest.Manifest{}, 0, err
		}
		prior = read
	}
	since := durable.sinceCheckpoint.Load()
	sinceBytes := durable.bytesSinceCheckpoint.Load()
	options.pagedText = durable.textStoredOnDisk()
	held, err := durable.captureLocked(ctx, prior, logged, options)
	if err != nil {
		return manifest.Manifest{}, 0, err
	}
	defer func() { held.release() }()
	if !options.consistent {
		if err := held.writeFrozenPartitions(durable.handle); err != nil {
			return manifest.Manifest{}, 0, err
		}
	}
	if err := durable.buildLoggedPartitions(ctx, store, prior, &held); err != nil {
		return manifest.Manifest{}, 0, err
	}
	written, err := durable.commitCheckpoint(ctx, store, prior, held)
	if err != nil {
		return manifest.Manifest{}, 0, err
	}
	durable.noteCheckpointCommitted(since, sinceBytes, int64(held.left))
	if !logged {
		return written, held.left, nil
	}
	if err := durable.truncateCovered(held.seqNos); err != nil {
		return written, held.left, err
	}
	return written, held.left, writeahead.RemoveBeyondCount(durable.manager.directory, durable.handle.Name,
		len(durable.partitions))
}

func (durable *Durable) commitCheckpoint(ctx context.Context, store checkpoint.Store, prior *manifest.Manifest,
	held capture) (manifest.Manifest, error) {
	meta, err := durable.handle.metadata(uint64(durable.handle.Index.Count()))
	if err != nil {
		return manifest.Manifest{}, err
	}
	input := checkpointInput(durable.handle, meta, prior, held)
	written, err := checkpoint.WriteFiles(ctx, store, input)
	if err != nil {
		return manifest.Manifest{}, err
	}
	if err := compactWritten(ctx, store, durable.handle, prior, &written,
		durable.manager.settings.CompactionThreshold, durable.textStoredOnDisk()); err != nil {
		return manifest.Manifest{}, err
	}
	if err := checkpoint.CommitManifest(ctx, store, durable.handle.Name, written); err != nil {
		return manifest.Manifest{}, err
	}
	if err := written.Record(ctx); err != nil {
		return written.Manifest, err
	}
	if err := durable.adoptWritten(ctx, store, written.Manifest, held); err != nil {
		return written.Manifest, err
	}
	if durable.heldFiles.Load() == 0 {
		if err := durable.removeGarbage(ctx, store, written.Garbage); err != nil {
			return written.Manifest, err
		}
	}
	return written.Manifest, durable.writeMetadata(ctx, uint64(durable.handle.Index.Count()))
}
