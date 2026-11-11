package earlier

import (
	"math"
	"strconv"
	"strings"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/form"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

type SegmentRef struct {
	ID             uint64
	Key            string
	DocCount       uint32
	TombstoneCount uint32
}

type PartitionEntry struct {
	PartitionID   uint32
	NextSegmentID uint64
	Segments      []SegmentRef
}

type VectorFileRef struct {
	ID    uint64
	Key   string
	Count uint32
	Dead  model.Optional[[]byte]
}

type VectorFieldRef struct {
	FieldPath       string
	NextFileID      uint64
	Files           []VectorFileRef
	GraphGeneration uint64
	GraphKey        model.Optional[string]
}

type Manifest struct {
	Schema     map[string]string
	Language   string
	Checkpoint []manifest.PartitionCheckpoint
	Partitions []PartitionEntry
	Vectors    []VectorFieldRef
}

func isKey(value any) (string, bool) {
	key, isString := value.(string)
	return key, isString && key != "" && !strings.ContainsRune(key, 0)
}

func safeUint(value any, maximum uint64) (uint64, bool) {
	number, isNumber := value.(float64)
	if !isNumber || number < 0 || number != math.Trunc(number) || number > form.MaxSafeInteger || uint64(number) > maximum {
		return 0, false
	}
	return uint64(number), true
}

func flatSchema(payload map[string]any, fields *form.Fields) (map[string]string, error) {
	raw, isMap := payload["schema"].(map[string]any)
	if !isMap {
		fields.Fail("schema", "is missing or is not a map")
		return nil, fields.Err()
	}
	if err := schema.RequireValidFieldTypes(raw); err != nil {
		return nil, err
	}
	flat := make(map[string]string, len(raw))
	for path, value := range raw {
		typeName, _ := value.(string)
		flat[path] = typeName
	}
	return flat, nil
}

func DecodeManifest(payload map[string]any) (Manifest, error) {
	fields := form.NewFields(payload, "", narsilerr.CodePersistenceLoadFailed, "segment manifest of the earlier layout")
	flat, err := flatSchema(payload, fields)
	if err != nil {
		return Manifest{}, err
	}
	decoded := Manifest{Schema: flat, Language: fields.String("language")}
	if fields.Err() != nil {
		return Manifest{}, fields.Err()
	}
	decoded.Checkpoint = lenientCheckpoints(payload["checkpoint"])
	decoded.Partitions = earlierPartitions(fields)
	decoded.Vectors = earlierVectorFields(fields, payload["vectors"])
	return decoded, fields.Err()
}

func lenientCheckpoints(raw any) []manifest.PartitionCheckpoint {
	list, _ := raw.([]any)
	checkpoints := make([]manifest.PartitionCheckpoint, 0, len(list))
	for _, element := range list {
		record, _ := element.(map[string]any)
		partitionID, validPartition := safeUint(record["partitionId"], math.MaxUint32)
		lastSeqNo, validLast := safeUint(record["lastSeqNo"], form.MaxSafeInteger)
		primaryTerm, validTerm := safeUint(record["primaryTerm"], form.MaxSafeInteger)
		if !validPartition || !validLast || !validTerm {
			continue
		}
		checkpoints = append(checkpoints, manifest.PartitionCheckpoint{
			PartitionID: uint32(partitionID), LastSeqNo: lastSeqNo, PrimaryTerm: primaryTerm,
		})
	}
	return checkpoints
}

func earlierPartitions(fields *form.Fields) []PartitionEntry {
	list := fields.List("partitions")
	partitions := make([]PartitionEntry, 0, len(list))
	for index := range list {
		path := "partitions[" + strconv.Itoa(index) + "]"
		entry := fields.Element(list, "partitions", index)
		partition := PartitionEntry{PartitionID: uint32(entry.Uint("partitionId", manifest.MaxPartitionID))}
		if fields.Err() != nil {
			return nil
		}
		partition.Segments = earlierSegments(fields, entry, path)
		partition.NextSegmentID = entry.Uint("nextSegmentId", manifest.MaxSegmentID)
		if fields.Err() != nil {
			return nil
		}
		for _, segment := range partition.Segments {
			if segment.ID >= partition.NextSegmentID {
				fields.Fail(path+".nextSegmentId", "does not exceed segment id "+strconv.FormatUint(segment.ID, 10))
				return nil
			}
		}
		partitions = append(partitions, partition)
	}
	return partitions
}

func earlierSegments(fields *form.Fields, entry *form.Fields, path string) []SegmentRef {
	if !entry.Has("segments") {
		return nil
	}
	list, isList := entry.Value("segments").([]any)
	if !isList || len(list) > manifest.MaxSegmentsPerPartition {
		fields.Fail(path+".segments", "is not a list of at most "+strconv.Itoa(manifest.MaxSegmentsPerPartition)+" segments")
		return nil
	}
	seen := make(map[uint64]bool, len(list))
	segments := make([]SegmentRef, 0, len(list))
	for index, element := range list {
		record, _ := element.(map[string]any)
		id, validID := safeUint(record["id"], manifest.MaxSegmentID)
		docCount, validDocs := safeUint(record["docCount"], math.MaxUint32)
		tombstones, validTombstones := safeUint(record["tombstoneCount"], math.MaxUint32)
		key, validKey := isKey(record["key"])
		if !validID || !validDocs || !validTombstones || !validKey || seen[id] {
			fields.Fail(path+".segments["+strconv.Itoa(index)+"]", "is not a valid segment reference")
			return nil
		}
		seen[id] = true
		segments = append(segments, SegmentRef{ID: id, Key: key, DocCount: uint32(docCount), TombstoneCount: uint32(tombstones)})
	}
	return segments
}

func earlierVectorFields(fields *form.Fields, raw any) []VectorFieldRef {
	if raw == nil {
		return nil
	}
	list, isList := raw.([]any)
	if !isList {
		fields.Fail("vectors", "is not a list")
		return nil
	}
	vectors := make([]VectorFieldRef, 0, len(list))
	for index, element := range list {
		path := "vectors[" + strconv.Itoa(index) + "]"
		record, _ := element.(map[string]any)
		fieldPath, validPath := record["fieldPath"].(string)
		nextFileID, validNext := safeUint(record["nextFileId"], manifest.MaxSegmentID)
		files, validFiles := record["files"].([]any)
		generation, validGeneration := safeUint(record["graphGeneration"], manifest.MaxSegmentID)
		if !validPath || !validNext || !validFiles || !validGeneration {
			fields.Fail(path, "is not a valid vector reference")
			return nil
		}
		field := VectorFieldRef{FieldPath: fieldPath, NextFileID: nextFileID, GraphGeneration: generation}
		if graphKey, present := record["graphKey"]; present && graphKey != nil {
			key, validKey := isKey(graphKey)
			if !validKey || generation == 0 {
				fields.Fail(path+".graphKey", "is not a valid graph key")
				return nil
			}
			field.GraphKey = model.Some(key)
		}
		for fileIndex, file := range files {
			ref, ok := earlierVectorFile(file)
			if !ok {
				fields.Fail(path+".files["+strconv.Itoa(fileIndex)+"]", "is not a valid vector file reference")
				return nil
			}
			field.Files = append(field.Files, ref)
		}
		vectors = append(vectors, field)
	}
	return vectors
}

func earlierVectorFile(raw any) (VectorFileRef, bool) {
	record, _ := raw.(map[string]any)
	id, validID := safeUint(record["id"], manifest.MaxSegmentID)
	key, validKey := isKey(record["key"])
	count, validCount := safeUint(record["count"], manifest.MaxVectorFileVectors)
	if !validID || !validKey || !validCount {
		return VectorFileRef{}, false
	}
	ref := VectorFileRef{ID: id, Key: key, Count: uint32(count)}
	dead, present := record["dead"]
	if !present || dead == nil {
		return ref, true
	}
	bytes, isBytes := dead.([]byte)
	if !isBytes || len(bytes) != manifest.DeadBytesFor(ref.Count) {
		return VectorFileRef{}, false
	}
	ref.Dead = model.Some(bytes)
	return ref, true
}
