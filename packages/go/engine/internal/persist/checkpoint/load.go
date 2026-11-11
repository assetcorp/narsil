package checkpoint

import (
	"context"
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/envelope"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/keyword"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/vector"
	"github.com/assetcorp/narsil/packages/go/engine/internal/vector/payload"
)

type ManifestKind uint8

const (
	ManifestAbsent ManifestKind = iota
	ManifestCurrent
	ManifestEarlier
)

type Read struct {
	Kind     ManifestKind
	Manifest manifest.Manifest
	Payload  map[string]any
}

func ReadManifest(ctx context.Context, store Store, indexName string) (Read, error) {
	data, found, err := store.Read(ctx, manifest.ManifestKey(indexName))
	if err != nil || !found {
		return Read{}, err
	}
	opened, err := manifest.Open(data)
	if err != nil {
		return Read{}, err
	}
	if manifest.IsEarlier(opened.Payload) {
		return Read{Kind: ManifestEarlier, Payload: opened.Payload}, nil
	}
	decoded, err := manifest.FromPayload(opened.Payload, indexName)
	if err != nil {
		return Read{}, err
	}
	return Read{Kind: ManifestCurrent, Manifest: decoded, Payload: opened.Payload}, nil
}

func ReclaimUnlisted(ctx context.Context, store Store, indexName string, referenced map[string]struct{}) error {
	keys, err := store.List(ctx, manifest.SegmentsPrefix(indexName))
	if err != nil {
		return err
	}
	for _, key := range keys {
		if _, kept := referenced[key]; kept {
			continue
		}
		if err := store.Remove(ctx, key); err != nil {
			return err
		}
	}
	return nil
}

func ReferencedKeys(listed manifest.Manifest) map[string]struct{} {
	referenced := map[string]struct{}{}
	for _, key := range listed.ListedKeys() {
		referenced[key] = struct{}{}
	}
	return referenced
}

func openKeyword(ref manifest.FileRef, data []byte) (*keyword.Segment, error) {
	opened, err := keyword.Open(data)
	if err != nil {
		return nil, err
	}
	if err := RequireChecksum(ref, opened.Header, "segment"); err != nil {
		return nil, err
	}
	if err := opened.Segment.Validate(); err != nil {
		return nil, err
	}
	return opened.Segment, nil
}

func RequireAgreedSchema(agreed map[string]string, found map[string]string, key string) error {
	for field, fieldType := range found {
		existing, listed := agreed[field]
		if listed && existing != fieldType {
			return narsilerr.New(narsilerr.CodePersistenceLoadFailed,
				`The segment "`+key+`" gives field "`+field+`" the type "`+fieldType+`", while the index gives it "`+
					existing+`"`, map[string]any{"key": key, "field": field, "existing": existing, "found": fieldType})
		}
	}
	return nil
}

func RequireListedCounts(ref manifest.SegmentRef, documentCount int, tombstoneCount int) error {
	if int64(ref.DocCount) == int64(documentCount) && int64(ref.TombstoneCount) == int64(tombstoneCount) {
		return nil
	}
	return narsilerr.New(narsilerr.CodePersistenceLoadFailed,
		`The segment "`+ref.File.Key+`" holds `+strconv.Itoa(documentCount)+` documents and `+
			strconv.Itoa(tombstoneCount)+` tombstones where the manifest lists `+
			strconv.FormatUint(uint64(ref.DocCount), 10)+` and `+strconv.FormatUint(uint64(ref.TombstoneCount), 10),
		map[string]any{"key": ref.File.Key, "documentCount": documentCount, "tombstoneCount": tombstoneCount,
			"listedDocCount": ref.DocCount, "listedTombstoneCount": ref.TombstoneCount})
}

func liveVectorsOf(ref manifest.VectorFieldRef) int {
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

func ReadGraphParts(ctx context.Context, store Store, ref manifest.VectorFieldRef) (*payload.GraphParts, error) {
	if len(ref.GraphParts) == 0 {
		return nil, nil
	}
	parts := make([]payload.GraphPart, 0, len(ref.GraphParts))
	for _, partRef := range ref.GraphParts {
		data, err := ReadListed(ctx, store, partRef, "graph part")
		if err != nil {
			return nil, err
		}
		part, header, err := payload.OpenGraphPart(data, `graph part "`+partRef.Key+`"`)
		if err != nil {
			return nil, err
		}
		if err := RequireChecksum(partRef, header, "graph part"); err != nil {
			return nil, err
		}
		if part.FieldName != ref.FieldPath {
			return nil, narsilerr.New(narsilerr.CodePersistenceLoadFailed,
				`The graph part "`+partRef.Key+`" names field "`+part.FieldName+`" where the manifest lists "`+
					ref.FieldPath+`"`, map[string]any{"key": partRef.Key})
		}
		parts = append(parts, part)
	}
	assembled, err := payload.AssembleGraphParts(parts)
	if err != nil {
		return nil, err
	}
	return &assembled, nil
}

func ReadVectorFile(ctx context.Context, store Store, file manifest.VectorFileRef, fieldPath string) (
	payload.VectorFile, envelope.Header, error) {
	data, err := ReadListed(ctx, store, file.File, "vector file")
	if err != nil {
		return payload.VectorFile{}, envelope.Header{}, err
	}
	opened, header, err := payload.OpenVectorFile(data, `vector file "`+file.File.Key+`"`)
	if err != nil {
		return payload.VectorFile{}, envelope.Header{}, err
	}
	if err := RequireChecksum(file.File, header, "vector file"); err != nil {
		return payload.VectorFile{}, envelope.Header{}, err
	}
	if len(opened.DocIDs) != int(file.Count) {
		return payload.VectorFile{}, envelope.Header{}, narsilerr.New(narsilerr.CodePersistenceLoadFailed,
			`The vector file "`+file.File.Key+`" holds `+strconv.Itoa(len(opened.DocIDs))+
				` vectors where the manifest counts `+strconv.FormatUint(uint64(file.Count), 10),
			map[string]any{"key": file.File.Key, "held": len(opened.DocIDs), "count": file.Count})
	}
	if opened.FieldName != fieldPath {
		return payload.VectorFile{}, envelope.Header{}, narsilerr.New(narsilerr.CodePersistenceLoadFailed,
			`The vector file "`+file.File.Key+`" names field "`+opened.FieldName+`" where the manifest lists "`+
				fieldPath+`"`, map[string]any{"key": file.File.Key})
	}
	return opened, header, nil
}

func requireDimension(key string, found int, expected int) error {
	if found == expected {
		return nil
	}
	return narsilerr.New(narsilerr.CodePersistenceLoadFailed,
		`The vector file "`+key+`" holds vectors of `+strconv.Itoa(found)+` dimensions where the schema gives `+
			strconv.Itoa(expected), map[string]any{"key": key, "found": found, "expected": expected})
}

func LoadVectorField(ctx context.Context, store Store, ref manifest.VectorFieldRef, field *vector.Field,
	dimension int) error {
	graph, err := ReadGraphParts(ctx, store, ref)
	if err != nil {
		return err
	}
	restore, err := field.RestoreCheckpoint(ctx, vector.CheckpointRestoreShape{
		LiveVectors: liveVectorsOf(ref), HoldsGraph: len(ref.GraphParts) > 0, Graph: graph})
	if err != nil {
		return err
	}
	for _, file := range ref.Files {
		opened, header, err := ReadVectorFile(ctx, store, file, ref.FieldPath)
		if err == nil {
			err = requireDimension(file.File.Key, opened.Dimension, dimension)
		}
		if err != nil {
			_ = restore.Abort()
			return err
		}
		loaded := vector.LoadedVectorFile{ID: file.ID, Key: file.File.Key, Payload: opened}
		if dead, marked := file.Dead.Get(); marked {
			loaded.Dead = dead
		}
		if path, located := store.PathOf(file.File.Key); located {
			offset := int64(envelope.HeaderBytes) + int64(header.PayloadLength) - int64(len(opened.Vectors))
			loaded.Location = &vector.VectorPartFile{Path: path, VectorsOffset: offset}
		}
		if err := restore.AddFile(loaded); err != nil {
			_ = restore.Abort()
			return err
		}
	}
	return restore.Finish()
}
