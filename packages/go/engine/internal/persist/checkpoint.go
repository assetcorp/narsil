package persist

import (
	"context"
	"sort"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/metadata"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/checkpoint"
	"github.com/assetcorp/narsil/packages/go/engine/internal/vector"
)

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
	locked         bool
}

func (durable *Durable) captureLocked(ctx context.Context, prior *manifest.Manifest, logged bool,
	options checkpointOptions) (held capture, err error) {
	consistent := options.consistent
	held = capture{seqNos: make([]uint64, len(durable.partitions))}
	locked := 0
	defer func() {
		for _, log := range durable.partitions[:locked] {
			log.mutex.Unlock()
		}
		if err != nil {
			held.stopTracking()
		}
	}()
	for _, log := range durable.partitions {
		if err := log.mutex.LockContext(ctx); err != nil {
			return held, err
		}
		locked++
	}
	for _, log := range durable.partitions {
		if log.failed != nil {
			return held, log.failed
		}
	}
	if options.pagedText {
		if err := held.trackChanges(ctx, durable.handle); err != nil {
			return held, err
		}
	}
	for partitionID, log := range durable.partitions {
		held.seqNos[partitionID] = log.applied
	}
	held.count = uint64(durable.handle.Index.Count())
	durable.planPartitions(prior, logged, options, &held)
	held.live = durable.liveDocumentCounts(ctx, &held)
	vectors, err := planVectors(ctx, durable.handle, prior, consistent)
	if err != nil {
		return held, err
	}
	held.vectors = vectors
	if err := held.freezeWholePartitions(ctx, durable.handle, options.pagedText); err != nil {
		held.release()
		return held, err
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

func (durable *Durable) prepareCheckpoint(ctx context.Context, logged bool) error {
	if durable.closed.Load() {
		return durable.closedError()
	}
	if err := durable.refuseFailedPartitions(ctx); err != nil {
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
