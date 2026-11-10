package persist

import (
	"context"
	"encoding/binary"
	"io"
	"math"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/export"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/checkpoint"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/storage"
)

type vectorLocation struct {
	file     int
	position int
}

type exportVectors struct {
	fieldPath string
	dimension int
	refs      []manifest.VectorFileRef
	held      [][]byte
	paths     []string
	located   map[string]vectorLocation
}

func (opened *Archive) locateVectors(ctx context.Context) ([]*exportVectors, error) {
	fields := make([]*exportVectors, 0, len(opened.Manifest.Vectors))
	for _, field := range opened.Manifest.Vectors {
		located := &exportVectors{fieldPath: field.FieldPath, refs: field.Files, located: map[string]vectorLocation{},
			held: make([][]byte, len(field.Files)), paths: make([]string, len(field.Files))}
		for at, ref := range field.Files {
			payload, _, err := checkpoint.ReadVectorFile(ctx, opened.store, ref, field.FieldPath)
			if err != nil {
				return nil, err
			}
			located.dimension = payload.Dimension
			if path, onDisk := opened.store.PathOf(ref.File.Key); onDisk {
				located.paths[at] = path
			} else {
				located.held[at] = payload.Vectors
			}
			for position, docID := range payload.DocIDs {
				if !ref.IsDead(uint32(position)) {
					located.located[docID] = vectorLocation{file: at, position: position}
				}
			}
		}
		fields = append(fields, located)
	}
	return fields, nil
}

func (field *exportVectors) vectorOf(docID string) ([]float32, bool, error) {
	location, found := field.located[docID]
	if !found {
		return nil, false, nil
	}
	width := field.dimension * 4
	raw := make([]byte, width)
	if held := field.held[location.file]; held != nil {
		copy(raw, held[location.position*width:(location.position+1)*width])
	} else {
		ref := field.refs[location.file]
		offset := int64(ref.File.Bytes) - int64(int(ref.Count)-location.position)*int64(width)
		file, err := storage.OpenForReading(field.paths[location.file])
		if err != nil {
			return nil, false, narsilerr.Wrap(narsilerr.CodePersistenceSaveFailed,
				`The vector file "`+ref.File.Key+`" cannot be read for the export`, err, nil)
		}
		_, err = file.ReadAt(raw, offset)
		_ = file.Close()
		if err != nil {
			return nil, false, narsilerr.Wrap(narsilerr.CodePersistenceSaveFailed,
				`The vector file "`+ref.File.Key+`" cannot be read for the export`, err, nil)
		}
	}
	values := make([]float32, field.dimension)
	for at := range values {
		values[at] = math.Float32frombits(binary.LittleEndian.Uint32(raw[at*4:]))
	}
	return values, true, nil
}

func (opened *Archive) winners(ctx context.Context, entry manifest.PartitionEntry) (map[string]int, error) {
	winners := map[string]int{}
	for at, ref := range entry.Segments {
		segment, err := checkpoint.OpenStoredSegment(ctx, opened.store, ref.File, opened.pagedText)
		if err != nil {
			return nil, err
		}
		for _, id := range segment.RemovedIDs() {
			delete(winners, id)
		}
		for ordinal := range segment.DocumentTotal() {
			winners[segment.DocumentID(ordinal)] = at
		}
	}
	return winners, nil
}

func (opened *Archive) exportSegment(writer *export.Writer, segment checkpoint.StoredSegment, at int,
	winners map[string]int, vectors []*exportVectors) error {
	for ordinal := range segment.DocumentTotal() {
		id := segment.DocumentID(ordinal)
		if winner, live := winners[id]; !live || winner != at {
			continue
		}
		document, err := segment.StoredDocument(ordinal)
		if err != nil {
			return err
		}
		found := map[string][]float32{}
		for _, field := range vectors {
			values, held, err := field.vectorOf(id)
			if err != nil {
				return err
			}
			if held {
				found[field.fieldPath] = values
			}
		}
		if err := writer.WriteDocument(id, withVectors(document, found)); err != nil {
			return err
		}
	}
	return nil
}

func (opened *Archive) Export(ctx context.Context, destination io.Writer, header map[string]any) error {
	writer, err := export.NewWriter(destination, export.Header{Index: header})
	if err != nil {
		return err
	}
	vectors, err := opened.locateVectors(ctx)
	if err != nil {
		return err
	}
	for _, entry := range opened.Manifest.Partitions {
		winners, err := opened.winners(ctx, entry)
		if err != nil {
			return err
		}
		for at, ref := range entry.Segments {
			segment, err := checkpoint.OpenStoredSegment(ctx, opened.store, ref.File, opened.pagedText)
			if err != nil {
				return err
			}
			if err := opened.exportSegment(writer, segment, at, winners, vectors); err != nil {
				return err
			}
		}
	}
	return nil
}
