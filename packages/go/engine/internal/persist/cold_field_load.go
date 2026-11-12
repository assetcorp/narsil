package persist

import (
	"context"
	"encoding/binary"
	"math"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/envelope"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/paged"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/checkpoint"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/storage"
	"github.com/assetcorp/narsil/packages/go/engine/internal/vector"
	"github.com/assetcorp/narsil/packages/go/engine/internal/vector/payload"
)

type coldPartitionResolver = func(ctx context.Context, docID string) (int32, bool, error)

func partitionResolver(handle *Handle) coldPartitionResolver {
	return func(ctx context.Context, docID string) (int32, bool, error) {
		held, err := handle.Index.Has(ctx, docID)
		if err != nil || !held {
			return 0, false, err
		}
		return int32(handle.Index.RoutePartition(docID)), true, nil
	}
}

func openColdVectorField(ctx context.Context, store checkpoint.Store, ref manifest.VectorFieldRef,
	field *vector.Field, resolve coldPartitionResolver) (bool, error) {
	if !holdsEveryHead(ref) {
		return false, nil
	}
	paths := make([]string, len(ref.Files))
	for at, file := range ref.Files {
		if err := requireListedSize(ctx, store, file.File, "vector file"); err != nil {
			return false, err
		}
		path, located := store.PathOf(file.File.Key)
		if !located {
			return false, nil
		}
		paths[at] = path
	}
	for _, part := range ref.GraphParts {
		if err := requireListedSize(ctx, store, part, "graph part"); err != nil {
			return false, err
		}
	}
	held := &coldHeld{}
	opened, err := openColdLayout(held, store, ref, paths, field, resolve)
	if err != nil || opened == nil {
		held.close()
		return false, err
	}
	field.OpenColdField(opened, loadColdFiles(store, ref, paths, field.Dimension()))
	return true, nil
}

func openColdLayout(held *coldHeld, store checkpoint.Store, ref manifest.VectorFieldRef, paths []string,
	field *vector.Field, resolve coldPartitionResolver) (vector.ColdVectorField, error) {
	codeBits := field.CodeBits()
	var codes *coldCodes
	files := make([]vector.ColdGraphFile, 0, len(ref.Files))
	for at, file := range ref.Files {
		opened, fileCodes, cold, err := openColdFile(held, paths[at], file, codeBits, codes)
		if err != nil || !cold {
			return nil, err
		}
		codes = fileCodes
		files = append(files, opened)
	}
	parts, first, cold, err := openColdParts(held, store, ref)
	if err != nil || !cold {
		return nil, err
	}
	input := vector.ColdGraphInput{Dimension: field.Dimension(), CodeBits: codeBits, Files: files, Parts: parts,
		EntryPoint: first.entryPoint, MaxLayer: first.maxLayer, ResolvePartition: resolve, FilePaths: held.paths,
		Close: held.close}
	if codes != nil {
		input.Centroid = codes.centroid
	}
	coldField, holdsEveryNode := vector.NewColdGraphField(input)
	if !holdsEveryNode {
		return nil, nil
	}
	return coldField, nil
}

func liveColdVectors(ref manifest.VectorFieldRef) int {
	live := 0
	for _, file := range ref.Files {
		for position := range file.Count {
			if !file.IsDead(position) {
				live++
			}
		}
	}
	return live
}

func loadColdFiles(store checkpoint.Store, ref manifest.VectorFieldRef, paths []string,
	dimension int) vector.ColdFieldLoad {
	return func(ctx context.Context, beginRestore func(shape vector.CheckpointRestoreShape) (*vector.CheckpointRestore,
		error), stillWanted func() bool, loadingWanted <-chan struct{}) error {
		timer := time.NewTimer(ColdLoadWaitWithoutSearch)
		select {
		case <-timer.C:
		case <-loadingWanted:
			timer.Stop()
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		}
		if !stillWanted() {
			return nil
		}
		graph, err := checkpoint.ReadGraphParts(ctx, store, ref)
		if err != nil || !stillWanted() {
			return err
		}
		restore, err := beginRestore(vector.CheckpointRestoreShape{LiveVectors: liveColdVectors(ref), HoldsGraph: true,
			Graph: graph})
		if err != nil {
			return err
		}
		for at, file := range ref.Files {
			if !stillWanted() {
				return nil
			}
			if err := addColdFile(ctx, restore, ref.FieldPath, file, paths[at], dimension); err != nil {
				return err
			}
		}
		if !stillWanted() {
			return nil
		}
		return restore.Finish()
	}
}

func coldDocIDs(source coldSource, section paged.Section, count int, key string) ([]string, error) {
	encoded, err := paged.ReadSectionChecked(source.reader, section, key)
	if err != nil {
		return nil, err
	}
	decoded, err := codec.Unmarshal(encoded, codec.DecodeOptions{ErrorCode: narsilerr.CodePersistenceLoadFailed})
	listed, isList := decoded.([]any)
	if err != nil || !isList || len(listed) != count {
		return nil, coldLoadFailed(`The vector file "`+key+`" lists the wrong number of IDs`, key)
	}
	ids := make([]string, count)
	for at, value := range listed {
		id, isString := value.(string)
		if !isString {
			return nil, coldLoadFailed(`The vector file "`+key+`" lists an ID that is not a string`, key)
		}
		ids[at] = id
	}
	return ids, nil
}

func coldMagnitudes(source coldSource, section paged.Section, key string) ([]float64, error) {
	encoded, err := paged.ReadSectionChecked(source.reader, section, key)
	if err != nil {
		return nil, err
	}
	magnitudes := make([]float64, len(encoded)/float64Bytes)
	for at := range magnitudes {
		magnitudes[at] = math.Float64frombits(binary.LittleEndian.Uint64(encoded[at*float64Bytes:]))
	}
	return magnitudes, nil
}

func addColdFile(ctx context.Context, restore *vector.CheckpointRestore, fieldPath string, ref manifest.VectorFileRef,
	path string, dimension int) error {
	key := ref.File.Key
	if err := ctx.Err(); err != nil {
		return err
	}
	file, err := storage.OpenForReading(path)
	if err != nil {
		return narsilerr.Wrap(narsilerr.CodePersistenceLoadFailed, `The file "`+key+`" cannot be opened`, err,
			map[string]any{"key": key})
	}
	native, err := paged.OpenNativeFile(file, path)
	if err != nil {
		return err
	}
	defer func() { _ = native.Close() }()
	source := coldSource{reader: native, size: native.Size(), close: func() {}}
	sections, cold, err := coldSectionsOf(source, ref.File)
	if err != nil {
		return err
	}
	if !cold {
		return coldLoadFailed(`The vector file "`+key+`" holds no head`, key)
	}
	idSection, err := requiredColdSection(sections, "docIds", key)
	if err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	ids, err := coldDocIDs(source, idSection, int(ref.Count), key)
	if err != nil {
		return err
	}
	var records []byte
	if section, listed := sections["records"]; listed {
		if err := ctx.Err(); err != nil {
			return err
		}
		if records, err = paged.ReadSectionChecked(source.reader, section, key); err != nil {
			return err
		}
	}
	magnitudeSection, err := requiredColdSection(sections, "magnitudes", key)
	if err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	magnitudes, err := coldMagnitudes(source, magnitudeSection, key)
	if err != nil {
		return err
	}
	vectors, err := requiredColdSection(sections, "vectors", key)
	if err != nil {
		return err
	}
	if err := paged.CheckSectionPages(ctx, source.reader, vectors, key); err != nil {
		return err
	}
	codes, err := coldCodesOf(source, sections, key)
	if err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	held := payload.VectorFile{FieldName: fieldPath, Dimension: dimension, DocIDs: ids, Vectors: []byte{}}
	if records != nil && codes != nil {
		centroid := make([]float64, len(codes.centroid))
		for at, value := range codes.centroid {
			centroid[at] = float64(value)
		}
		held.Codes = &payload.Codes{Bits: uint8(codes.bits), Centroid: centroid, Records: records}
	}
	vectorsAt := envelope.HeaderBytes + vectors.Offset
	stride := int64(dimension) * float32Bytes
	loaded := vector.LoadedVectorFile{ID: ref.ID, Key: key, Payload: held,
		Location: &vector.VectorPartFile{Path: path, VectorsOffset: vectorsAt},
		ByParts: &vector.VectorFileByParts{Magnitudes: magnitudes, VectorAt: func(position int, target []float32) error {
			raw, err := readColdRange(source, vectorsAt+int64(position)*stride, stride, key)
			if err != nil {
				return err
			}
			for component := range target {
				target[component] = math.Float32frombits(binary.LittleEndian.Uint32(raw[component*float32Bytes:]))
			}
			return nil
		}}}
	if dead, marked := ref.Dead.Get(); marked {
		loaded.Dead = dead
	}
	return restore.AddFile(loaded)
}
