package engine

import (
	"math/bits"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/memory"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

func liveVectorsOf(file manifest.VectorFileRef) float64 {
	dead, marked := file.Dead.Get()
	if !marked {
		return float64(file.Count)
	}
	deadCount := 0
	for _, word := range dead {
		deadCount += bits.OnesCount8(word)
	}
	return float64(max(0, int(file.Count)-deadCount))
}

func vectorDimensionOf(schemaTypes map[string]string, path string) float64 {
	parsed, err := schema.ParseFieldType(schemaTypes[path], path)
	if err != nil {
		return 0
	}
	return float64(parsed.Dimension)
}

func restoreSizeOf(restoring persist.Restoring, durable bool) memory.RestoreSize {
	if restoring.Earlier {
		size := memory.RestoreSize{StoredBytes: float64(restoring.EarlierStoredBytes), Earlier: true}
		for _, vectors := range restoring.EarlierVectors {
			size.Vectors = append(size.Vectors,
				memory.VectorCount{Dimension: float64(vectors.Dimension), Count: float64(vectors.Count)})
		}
		return size
	}
	textStorage := model.TextStorage(restoring.Configuration.TextStorage.Or(""))
	size := memory.RestoreSize{TextOnDisk: durable && textStorage == model.TextStorageDisk}
	for _, partition := range restoring.Manifest.Partitions {
		for _, segment := range partition.Segments {
			size.StoredBytes += float64(segment.File.Bytes)
		}
	}
	for _, field := range restoring.Manifest.Vectors {
		dimension := vectorDimensionOf(restoring.Configuration.Schema, field.FieldPath)
		for _, file := range field.Files {
			size.Vectors = append(size.Vectors, memory.VectorCount{Dimension: dimension, Count: liveVectorsOf(file)})
		}
	}
	return size
}
