package persist

import (
	"context"
	"encoding/binary"
	"math"
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/earlier"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/envelope"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/checkpoint"
	"github.com/assetcorp/narsil/packages/go/engine/internal/vector"
	"github.com/assetcorp/narsil/packages/go/engine/internal/vector/payload"
)

const float32Bytes = 4

func readEarlierGraph(ctx context.Context, store checkpoint.Store, ref earlier.VectorFieldRef) (
	*payload.GraphParts, error) {
	key, present := ref.GraphKey.Get()
	if !present {
		return nil, nil
	}
	data, err := readEarlierFile(ctx, store, key, "graph file")
	if err != nil {
		return nil, err
	}
	opened, err := envelope.OpenChecksummed(data, envelope.Kind{FormatVersion: payload.VectorFileEnvelopeVersion,
		What: `graph file "` + key + `"`, AllowsGzip: true})
	if err != nil {
		return nil, err
	}
	raw, err := codec.Unmarshal(opened.Payload, codec.DecodeOptions{ErrorCode: narsilerr.CodePersistenceLoadFailed})
	if err != nil {
		return nil, err
	}
	part, err := payload.DecodeEarlierGraph(raw)
	if err != nil {
		return nil, err
	}
	graphs := payload.GraphPartsOfEarlier(part)
	return &graphs, nil
}

func liveEarlierVectors(ref earlier.VectorFieldRef) int {
	live := 0
	for _, file := range ref.Files {
		listed := manifest.VectorFileRef{Count: file.Count, Dead: file.Dead}
		for position := range file.Count {
			if !listed.IsDead(position) {
				live++
			}
		}
	}
	return live
}

func loadEarlierVectorField(ctx context.Context, store checkpoint.Store, ref earlier.VectorFieldRef,
	field *vector.Field) (manifest.VectorFieldRef, error) {
	prior := manifest.VectorFieldRef{FieldPath: ref.FieldPath, NextFileID: ref.NextFileID,
		Files: []manifest.VectorFileRef{}, GraphGeneration: ref.GraphGeneration, GraphParts: []manifest.FileRef{}}
	graph, err := readEarlierGraph(ctx, store, ref)
	if err != nil {
		return prior, err
	}
	_, holdsGraph := ref.GraphKey.Get()
	restore, err := field.RestoreCheckpoint(ctx, vector.CheckpointRestoreShape{
		LiveVectors: liveEarlierVectors(ref), HoldsGraph: holdsGraph, Graph: graph})
	if err != nil {
		return prior, err
	}
	for _, file := range ref.Files {
		listed, err := addEarlierVectorFile(ctx, store, restore, file, field)
		if err != nil {
			_ = restore.Abort()
			return prior, err
		}
		prior.Files = append(prior.Files, listed)
	}
	return prior, restore.Finish()
}

func addEarlierVectorFile(ctx context.Context, store checkpoint.Store, restore *vector.CheckpointRestore,
	file earlier.VectorFileRef, field *vector.Field) (manifest.VectorFileRef, error) {
	listed := manifest.VectorFileRef{ID: file.ID, Count: file.Count, Dead: file.Dead, File: manifest.FileRef{Key: file.Key}}
	data, err := readEarlierFile(ctx, store, file.Key, "vector file")
	if err != nil {
		return listed, err
	}
	opened, header, err := payload.OpenVectorFile(data, `vector file "`+file.Key+`"`)
	if err != nil {
		return listed, err
	}
	if len(opened.DocIDs) != int(file.Count) {
		return listed, earlierLoadFailed(`The vector file "`+file.Key+`" holds `+strconv.Itoa(len(opened.DocIDs))+
			" vectors where the manifest counts "+strconv.FormatUint(uint64(file.Count), 10),
			map[string]any{"key": file.Key})
	}
	if opened.Dimension != field.Dimension() {
		return listed, earlierLoadFailed(`The vector file "`+file.Key+`" holds vectors of `+
			strconv.Itoa(opened.Dimension)+" dimensions where the schema gives "+strconv.Itoa(field.Dimension()),
			map[string]any{"key": file.Key})
	}
	if err := manifest.FillFile(&listed.File, data); err != nil {
		return listed, err
	}
	loaded := vector.LoadedVectorFile{ID: file.ID, Key: file.Key, Payload: opened}
	if dead, marked := file.Dead.Get(); marked {
		loaded.Dead = dead
	}
	if path, located := store.PathOf(file.Key); located {
		offset := int64(envelope.HeaderBytes) + int64(header.PayloadLength) - int64(len(opened.Vectors))
		loaded.Location = &vector.VectorPartFile{Path: path, VectorsOffset: offset}
	}
	return listed, restore.AddFile(loaded)
}

type vectorPlace struct {
	field    int
	part     int
	position int
}

func float32sAt(vectors []byte, position int, dimension int) []float32 {
	values := make([]float32, dimension)
	base := position * dimension * float32Bytes
	for component := range values {
		values[component] = math.Float32frombits(binary.LittleEndian.Uint32(vectors[base+component*float32Bytes:]))
	}
	return values
}

func vectorPlaces(handle *Handle, fields []earlier.VectorField) (map[string][]vectorPlace, error) {
	places := map[string][]vectorPlace{}
	for fieldAt, field := range fields {
		declared, known := handle.Vectors[field.FieldPath]
		if !known {
			continue
		}
		for partAt, part := range field.Parts {
			if int(part.Dimension) != declared.Dimension() {
				return nil, earlierLoadFailed(`The vector index of field "`+field.FieldPath+`" holds vectors of `+
					strconv.FormatUint(uint64(part.Dimension), 10)+" dimensions where the schema gives "+
					strconv.Itoa(declared.Dimension()), map[string]any{"field": field.FieldPath})
			}
			for position, id := range part.DocIDs {
				places[id] = append(places[id], vectorPlace{field: fieldAt, part: partAt, position: position})
			}
		}
	}
	return places, nil
}

func applyEarlierWrites(handle *Handle, writes []Write) error {
	groups := map[int][]Write{}
	for _, write := range writes {
		partitionID := handle.Index.RoutePartition(write.DocumentID)
		groups[partitionID] = append(groups[partitionID], write)
	}
	for partitionID, group := range groups {
		if err := firstFailure(handle.apply(group, partitionID)); err != nil {
			return err
		}
	}
	return nil
}

func insertEarlierDocuments(handle *Handle, partitions [][]byte, fields []earlier.VectorField) error {
	places, err := vectorPlaces(handle, fields)
	if err != nil {
		return err
	}
	pending := make([]Write, 0, RecoveryInsertBatchDocuments)
	for _, data := range partitions {
		stored, err := earlier.DecodePartitionDocuments(data)
		if err != nil {
			return err
		}
		for _, id := range sortedDocumentIDs(stored.Documents) {
			write := Write{DocumentID: id, Document: stored.Documents[id]}
			for _, place := range places[id] {
				field := fields[place.field]
				part := field.Parts[place.part]
				if write.Vectors == nil {
					write.Vectors = map[string][]float32{}
				}
				write.Vectors[field.FieldPath] = float32sAt(part.Vectors, place.position, int(part.Dimension))
			}
			pending = append(pending, write)
			if len(pending) == RecoveryInsertBatchDocuments {
				if err := applyEarlierWrites(handle, pending); err != nil {
					return err
				}
				pending = pending[:0]
			}
		}
	}
	return applyEarlierWrites(handle, pending)
}
