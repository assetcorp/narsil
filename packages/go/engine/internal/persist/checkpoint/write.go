package checkpoint

import (
	"context"
	"io"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/keyword"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/segment"
	"github.com/assetcorp/narsil/packages/go/engine/internal/vector"
	"github.com/assetcorp/narsil/packages/go/engine/internal/vector/payload"
)

type PartitionCapture struct {
	Checkpoint manifest.PartitionCheckpoint
	Rewritten  bool
	Segments   []*keyword.Segment
	Stream     func(ctx context.Context, entry *manifest.PartitionEntry) error
	Listed     *manifest.PartitionEntry
}

type VectorCapture struct {
	FieldPath string
	Field     *vector.Field
	Plan      *vector.CheckpointPlan
}

type Input struct {
	IndexName          string
	Schema             map[string]string
	SchemaOrder        []string
	Language           string
	AnalysisGeneration uint64
	Prior              *manifest.Manifest
	Partitions         []PartitionCapture
	Vectors            []VectorCapture
}

type writtenField struct {
	capture VectorCapture
	files   []vector.WrittenVectorFile
	layouts []vector.VectorFileLayout
}

type Written struct {
	Manifest manifest.Manifest
	Garbage  []string
	fields   []writtenField
}

func priorPartition(prior *manifest.Manifest, partitionID uint32) (manifest.PartitionEntry, bool) {
	if prior == nil {
		return manifest.PartitionEntry{}, false
	}
	for _, entry := range prior.Partitions {
		if entry.PartitionID == partitionID {
			return entry, true
		}
	}
	return manifest.PartitionEntry{}, false
}

func priorField(prior *manifest.Manifest, fieldPath string) (manifest.VectorFieldRef, bool) {
	if prior == nil {
		return manifest.VectorFieldRef{}, false
	}
	for _, field := range prior.Vectors {
		if field.FieldPath == fieldPath {
			return field, true
		}
	}
	return manifest.VectorFieldRef{}, false
}

func writeSegments(ctx context.Context, store Store, input Input, capture PartitionCapture) (
	manifest.PartitionEntry, error) {
	partitionID := capture.Checkpoint.PartitionID
	if capture.Listed != nil {
		return *capture.Listed, nil
	}
	prior, hadPrior := priorPartition(input.Prior, partitionID)
	if !capture.Rewritten && hadPrior {
		return prior, nil
	}
	entry := manifest.PartitionEntry{PartitionID: partitionID, NextSegmentID: prior.NextSegmentID,
		Segments: []manifest.SegmentRef{}}
	if capture.Stream != nil {
		return entry, capture.Stream(ctx, &entry)
	}
	return entry, AppendSegments(ctx, store, input.IndexName, &entry, capture.Segments)
}

func requireRoom(entry *manifest.PartitionEntry, adding int) error {
	if len(entry.Segments)+adding > manifest.MaxSegmentsPerPartition {
		return narsilerr.New(narsilerr.CodePersistenceSaveFailed,
			"The checkpoint would list more segments for one partition than a manifest holds",
			map[string]any{"partitionId": entry.PartitionID, "segments": len(entry.Segments) + adding})
	}
	if entry.NextSegmentID > manifest.MaxSegmentID {
		return narsilerr.New(narsilerr.CodePersistenceSaveFailed,
			"The partition has used every segment number a manifest accepts",
			map[string]any{"partitionId": entry.PartitionID})
	}
	return nil
}

func AppendSegments(ctx context.Context, store Store, indexName string, entry *manifest.PartitionEntry,
	segments []*keyword.Segment) error {
	if err := requireRoom(entry, len(segments)); err != nil {
		return err
	}
	for _, segment := range segments {
		if err := requireRoom(entry, 0); err != nil {
			return err
		}
		id := entry.NextSegmentID
		ref := manifest.FileRef{Key: manifest.SegmentKey(indexName, entry.PartitionID, id)}
		packed, err := keyword.Pack(segment, false)
		if err != nil {
			return err
		}
		if err := manifest.FillFile(&ref, packed); err != nil {
			return err
		}
		if err := store.Write(ctx, ref.Key, packed); err != nil {
			return err
		}
		entry.NextSegmentID++
		entry.Segments = append(entry.Segments, manifest.SegmentRef{ID: id, DocCount: segment.DocumentCount,
			TombstoneCount: uint32(len(segment.Tombstones)), File: ref})
	}
	return nil
}

func AppendStreamed(ctx context.Context, store Store, indexName string, entry *manifest.PartitionEntry,
	streamed segment.StreamedSegment) error {
	if err := requireRoom(entry, 1); err != nil {
		return err
	}
	id := entry.NextSegmentID
	ref := manifest.FileRef{Key: manifest.SegmentKey(indexName, entry.PartitionID, id)}
	streaming, streams := store.(StreamingStore)
	path, held := store.PathOf(ref.Key)
	if !streams || !held {
		return narsilerr.New(narsilerr.CodePersistenceSaveFailed,
			`Index "`+indexName+`" stores its text on disk, which needs a durable directory`,
			map[string]any{"indexName": indexName})
	}
	var written keyword.Written
	var documents uint32
	err := streaming.WriteStream(ctx, ref.Key, func(writer io.Writer) error {
		var err error
		written, documents, err = segment.WriteStreamed(ctx, writer, path, streamed)
		return err
	})
	if err != nil {
		return err
	}
	ref.Bytes, ref.Checksum = uint64(written.Bytes), written.Checksum
	entry.NextSegmentID++
	entry.Segments = append(entry.Segments, manifest.SegmentRef{ID: id, DocCount: documents,
		TombstoneCount: uint32(len(streamed.Tombstones)), File: ref})
	return nil
}

func headOf(written payload.Written) model.Optional[manifest.Head] {
	if !written.HasHead {
		return model.Optional[manifest.Head]{}
	}
	return model.Some(manifest.Head{Offset: uint64(written.HeadOffset), Length: uint32(written.HeadLength),
		Checksum: written.HeadChecksum})
}

func keptRef(prior manifest.VectorFieldRef, kept vector.KeptVectorFile) (manifest.VectorFileRef, error) {
	for _, file := range prior.Files {
		if file.File.Key != kept.Key {
			continue
		}
		ref := file
		ref.ID = kept.ID
		ref.Count = uint32(kept.Count)
		ref.Dead = model.Optional[[]byte]{}
		if kept.Dead != nil {
			ref.Dead = model.Some(kept.Dead)
		}
		return ref, nil
	}
	return manifest.VectorFileRef{}, narsilerr.New(narsilerr.CodePersistenceSaveFailed,
		`The checkpoint keeps the vector file "`+kept.Key+`", which the previous manifest does not list`,
		map[string]any{"key": kept.Key})
}

func writeField(ctx context.Context, store Store, input Input, capture VectorCapture) (manifest.VectorFieldRef,
	writtenField, error) {
	prior, hadPrior := priorField(input.Prior, capture.FieldPath)
	done := writtenField{capture: capture}
	if capture.Plan.Unchanged() && hadPrior {
		return prior, done, nil
	}
	ref := manifest.VectorFieldRef{FieldPath: capture.FieldPath, NextFileID: prior.NextFileID,
		Files: []manifest.VectorFileRef{}, GraphGeneration: prior.GraphGeneration, GraphParts: []manifest.FileRef{}}
	for _, kept := range capture.Plan.Kept() {
		file, err := keptRef(prior, kept)
		if err != nil {
			return ref, done, err
		}
		ref.Files = append(ref.Files, file)
	}
	for index := range capture.Plan.NewFiles() {
		file, err := capture.Plan.ReadNewFile(ctx, index)
		if err != nil {
			return ref, done, err
		}
		id := ref.NextFileID
		ref.NextFileID++
		key, err := manifest.VectorFileKey(input.IndexName, capture.FieldPath, id)
		if err != nil {
			return ref, done, err
		}
		disk := capture.Plan.StoresHeads() && file.Magnitudes != nil
		packed, err := payload.PackVectorFile(file.Payload, file.Magnitudes, disk, `vector file "`+key+`"`)
		if err != nil {
			return ref, done, err
		}
		fileRef := manifest.FileRef{Key: key, Head: headOf(packed)}
		if err := manifest.FillFile(&fileRef, packed.Bytes); err != nil {
			return ref, done, err
		}
		if err := store.Write(ctx, key, packed.Bytes); err != nil {
			return ref, done, err
		}
		listed := manifest.VectorFileRef{ID: id, Count: uint32(len(file.Payload.DocIDs)), File: fileRef}
		if file.Dead != nil {
			listed.Dead = model.Some(file.Dead)
		}
		ref.Files = append(ref.Files, listed)
		done.files = append(done.files, vector.WrittenVectorFile{ID: id, Key: key, Ordinals: file.Ordinals})
		if path, located := store.PathOf(key); located {
			done.layouts = append(done.layouts, vector.VectorFileLayout{
				VectorPartFile: vector.VectorPartFile{Path: path,
					VectorsOffset: int64(len(packed.Bytes) - len(file.Payload.Vectors))},
				DocIDs: file.Payload.DocIDs, Dead: file.Dead})
		}
	}
	parts := capture.Plan.GraphParts()
	if len(parts) > 0 {
		ref.GraphGeneration++
		for index, part := range parts {
			key, err := manifest.GraphPartKey(input.IndexName, capture.FieldPath, ref.GraphGeneration, uint64(index))
			if err != nil {
				return ref, done, err
			}
			packed, err := payload.PackGraphPart(part, capture.Plan.StoresHeads(), false, `graph part "`+key+`"`)
			if err != nil {
				return ref, done, err
			}
			partRef := manifest.FileRef{Key: key, Head: headOf(packed)}
			if err := manifest.FillFile(&partRef, packed.Bytes); err != nil {
				return ref, done, err
			}
			if err := store.Write(ctx, key, packed.Bytes); err != nil {
				return ref, done, err
			}
			ref.GraphParts = append(ref.GraphParts, partRef)
		}
	}
	return ref, done, nil
}

func WriteFiles(ctx context.Context, store Store, input Input) (Written, error) {
	written := Written{Manifest: manifest.Manifest{
		Schema:             input.Schema,
		SchemaOrder:        input.SchemaOrder,
		Language:           input.Language,
		AnalysisGeneration: input.AnalysisGeneration,
		Checkpoint:         []manifest.PartitionCheckpoint{},
		Partitions:         []manifest.PartitionEntry{},
		Vectors:            []manifest.VectorFieldRef{},
	}}
	for _, capture := range input.Partitions {
		entry, err := writeSegments(ctx, store, input, capture)
		if err != nil {
			return written, err
		}
		written.Manifest.Partitions = append(written.Manifest.Partitions, entry)
		written.Manifest.Checkpoint = append(written.Manifest.Checkpoint, capture.Checkpoint)
	}
	for _, capture := range input.Vectors {
		ref, field, err := writeField(ctx, store, input, capture)
		if err != nil {
			return written, err
		}
		written.Manifest.Vectors = append(written.Manifest.Vectors, ref)
		written.fields = append(written.fields, field)
	}
	if input.Prior != nil {
		listed := ReferencedKeys(written.Manifest)
		for _, key := range input.Prior.ListedKeys() {
			if _, kept := listed[key]; !kept {
				written.Garbage = append(written.Garbage, key)
			}
		}
	}
	return written, nil
}

func CommitManifest(ctx context.Context, store Store, indexName string, written Written) error {
	encoded, err := manifest.Encode(written.Manifest, indexName, false)
	if err != nil {
		return err
	}
	return store.Write(ctx, manifest.ManifestKey(indexName), encoded)
}

func (written Written) Record(ctx context.Context) error {
	for _, field := range written.fields {
		if field.capture.Plan.Unchanged() {
			continue
		}
		field.capture.Field.RecordCheckpoint(field.capture.Plan, field.files)
		for _, layout := range field.layouts {
			if err := field.capture.Field.AdoptDiskLayout(ctx, layout); err != nil {
				return err
			}
		}
	}
	return nil
}

func RemoveGarbage(ctx context.Context, store Store, garbage []string, fields []*vector.Field) ([]string, error) {
	inUse := map[string]struct{}{}
	for _, field := range fields {
		for _, path := range field.VectorFilesInUse() {
			inUse[path] = struct{}{}
		}
	}
	var stillRead []string
	for position, key := range garbage {
		if path, located := store.PathOf(key); located {
			if _, read := inUse[path]; read {
				stillRead = append(stillRead, key)
				continue
			}
		}
		if err := store.Remove(ctx, key); err != nil {
			return append(stillRead, garbage[position:]...), err
		}
	}
	return stillRead, nil
}
