package persist

import (
	"context"
	"encoding/binary"
	"io"
	"math"
	"strings"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/export"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
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

func exportScan(writer *export.Writer, scans []segmentScan, at int, vectors []*exportVectors) error {
	scan := scans[at]
	for ordinal := range scan.count {
		id, err := scan.idAt(ordinal)
		if err != nil {
			return err
		}
		latest, err := countsAsLatestHolder(scans, at, id)
		if err != nil {
			return err
		}
		if !latest {
			continue
		}
		encoded, err := scan.encodedAt(ordinal)
		if err != nil {
			return err
		}
		stored, err := storedEntries(encoded)
		if err != nil {
			return err
		}
		document := withoutVectorFields(stored, scan.schema)
		for _, field := range vectors {
			values, held, err := field.vectorOf(id)
			if err != nil {
				return err
			}
			if held {
				document = withNestedValue(document, strings.Split(field.fieldPath, "."), values)
			}
		}
		if err := writer.WriteStoredDocument(id, document); err != nil {
			return err
		}
	}
	return nil
}

func (opened *Archive) Export(ctx context.Context, destination io.Writer, header codec.OrderedMap,
	epoch model.Optional[string]) error {
	var positions *export.ChangePositions
	if held, set := epoch.Get(); set {
		count := 0
		for _, entry := range opened.Manifest.Partitions {
			count = max(count, int(entry.PartitionID)+1)
		}
		for _, entry := range opened.Manifest.Checkpoint {
			count = max(count, int(entry.PartitionID)+1)
		}
		positions = &export.ChangePositions{Epoch: held, LastSeqNos: make([]uint64, count)}
		for partitionID := range positions.LastSeqNos {
			positions.LastSeqNos[partitionID] = opened.Manifest.LastSeqNo(uint32(partitionID))
		}
	}
	writer, err := export.NewWriterInStoredOrder(destination, header, positions)
	if err != nil {
		return err
	}
	vectors, err := opened.locateVectors(ctx)
	if err != nil {
		return err
	}
	for _, entry := range opened.Manifest.Partitions {
		if err := opened.exportPartition(ctx, writer, entry, vectors); err != nil {
			return err
		}
	}
	return nil
}

func (opened *Archive) exportPartition(ctx context.Context, writer *export.Writer, entry manifest.PartitionEntry,
	vectors []*exportVectors) error {
	scans := make([]segmentScan, 0, len(entry.Segments))
	defer func() { closeScans(scans) }()
	for _, ref := range entry.Segments {
		scan, err := openSegmentScan(ctx, opened.store, ref.File, opened.pagedText)
		if err != nil {
			return err
		}
		scans = append(scans, scan)
	}
	for at := range scans {
		if err := exportScan(writer, scans, at, vectors); err != nil {
			return err
		}
	}
	return nil
}
