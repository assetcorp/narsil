package manifest

import (
	"math"
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/envelope"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/form"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

type Opened struct {
	Header  envelope.Header
	Payload map[string]any
}

func Open(data []byte) (Opened, error) {
	opened, err := envelope.OpenChecksummed(data, EnvelopeKind)
	if err != nil {
		return Opened{}, err
	}
	decoded, err := codec.Unmarshal(opened.Payload, codec.DecodeOptions{ErrorCode: narsilerr.CodePersistenceLoadFailed})
	if err != nil {
		return Opened{}, err
	}
	payload, ok := decoded.(map[string]any)
	if !ok {
		return Opened{}, narsilerr.New(narsilerr.CodePersistenceLoadFailed, "Segment manifest is not a map", nil)
	}
	return Opened{Header: opened.Header, Payload: payload}, nil
}

func IsEarlier(payload map[string]any) bool {
	version, ok := payload["version"].(float64)
	return ok && version == EarlierVersion
}

func Decode(data []byte, indexName string) (Opened, Manifest, error) {
	opened, err := Open(data)
	if err != nil {
		return Opened{}, Manifest{}, err
	}
	decoded, err := FromPayload(opened.Payload, indexName)
	return opened, decoded, err
}

func FromPayload(payload map[string]any, indexName string) (Manifest, error) {
	version, ok := payload["version"].(float64)
	if !ok || version != Version {
		return Manifest{}, narsilerr.New(narsilerr.CodeEnvelopeVersionMismatch,
			"The segment manifest of index \""+indexName+"\" holds a layout other than "+strconv.Itoa(Version)+
				", which this release cannot open. Export the index with the release that wrote it and import the export",
			map[string]any{"indexName": indexName, "version": payload["version"]})
	}
	return readManifest(payload, readMode{indexName: indexName, placement: true, code: narsilerr.CodePersistenceLoadFailed})
}

type readMode struct {
	indexName string
	placement bool
	code      string
}

type manifestReader struct {
	root *form.Fields
	mode readMode
}

func readManifest(payload map[string]any, mode readMode) (Manifest, error) {
	reader := manifestReader{root: form.NewFields(payload, "", mode.code, "segment manifest"), mode: mode}
	root := reader.root
	rawSchema, isMap := payload["schema"].(map[string]any)
	if !isMap {
		root.Fail("schema", "is missing or is not a map")
		return Manifest{}, root.Err()
	}
	if err := schema.RequireValidFieldTypes(rawSchema); err != nil {
		return Manifest{}, err
	}
	decoded := Manifest{Schema: make(map[string]string, len(rawSchema)), Language: root.String("language")}
	for path, value := range rawSchema {
		typeName, _ := value.(string)
		decoded.Schema[path] = typeName
	}
	if root.Has("analysisGeneration") {
		decoded.AnalysisGeneration = root.Uint("analysisGeneration", form.MaxSafeInteger)
	}
	decoded.Checkpoint = reader.checkpoints(root.List("checkpoint"))
	decoded.Partitions = reader.partitions(root.List("partitions"))
	decoded.Vectors = reader.vectorFields(root.List("vectors"))
	if err := root.Err(); err != nil {
		return Manifest{}, err
	}
	return decoded, nil
}

func indexed(path string, index int) string {
	return path + "[" + strconv.Itoa(index) + "]"
}

func (reader manifestReader) checkpoints(list []any) []PartitionCheckpoint {
	seen := make(map[uint32]bool, len(list))
	checkpoints := make([]PartitionCheckpoint, 0, len(list))
	for index := range list {
		entry := reader.root.Element(list, "checkpoint", index)
		checkpoint := PartitionCheckpoint{
			PartitionID: uint32(entry.Uint("partitionId", MaxPartitionID)),
			LastSeqNo:   entry.Uint("lastSeqNo", form.MaxSafeInteger),
			PrimaryTerm: entry.Uint("primaryTerm", form.MaxSafeInteger),
		}
		if reader.root.Err() != nil {
			return nil
		}
		if seen[checkpoint.PartitionID] {
			reader.root.Fail(indexed("checkpoint", index), "repeats partition "+strconv.FormatUint(uint64(checkpoint.PartitionID), 10))
			return nil
		}
		seen[checkpoint.PartitionID] = true
		if entry.Has("termHistory") {
			checkpoint.TermHistory = model.Some(reader.termHistory(entry, indexed("checkpoint", index), checkpoint.LastSeqNo))
		}
		checkpoints = append(checkpoints, checkpoint)
	}
	return checkpoints
}

func (reader manifestReader) termHistory(entry *form.Fields, path string, lastSeqNo uint64) []TermStart {
	list := entry.List("termHistory")
	history := make([]TermStart, 0, len(list))
	for index := range list {
		start := entry.Element(list, "termHistory", index)
		read := TermStart{
			PrimaryTerm: start.Uint("primaryTerm", form.MaxSafeInteger),
			FirstSeqNo:  start.Uint("firstSeqNo", form.MaxSafeInteger),
		}
		if reader.root.Err() != nil {
			return nil
		}
		at := indexed(path+".termHistory", index)
		if read.FirstSeqNo > lastSeqNo {
			reader.root.Fail(at, "starts a term at seqNo "+strconv.FormatUint(read.FirstSeqNo, 10)+
				", above lastSeqNo "+strconv.FormatUint(lastSeqNo, 10))
			return nil
		}
		if len(history) > 0 {
			previous := history[len(history)-1]
			if read.PrimaryTerm <= previous.PrimaryTerm || read.FirstSeqNo <= previous.FirstSeqNo {
				reader.root.Fail(at, "fails to ascend strictly from the term before it")
				return nil
			}
		}
		history = append(history, read)
	}
	return history
}

func (reader manifestReader) partitions(list []any) []PartitionEntry {
	seen := make(map[uint32]bool, len(list))
	partitions := make([]PartitionEntry, 0, len(list))
	for index := range list {
		path := indexed("partitions", index)
		entry := reader.root.Element(list, "partitions", index)
		partitionID := uint32(entry.Uint("partitionId", MaxPartitionID))
		if reader.root.Err() != nil {
			return nil
		}
		if seen[partitionID] {
			reader.root.Fail(path, "repeats partition "+strconv.FormatUint(uint64(partitionID), 10))
			return nil
		}
		seen[partitionID] = true
		segments := reader.segments(entry, path, partitionID)
		nextSegmentID := entry.Uint("nextSegmentId", MaxSegmentID)
		if reader.root.Err() != nil {
			return nil
		}
		for _, segment := range segments {
			if segment.ID >= nextSegmentID {
				reader.root.Fail(path+".nextSegmentId", "does not exceed segment id "+strconv.FormatUint(segment.ID, 10))
				return nil
			}
		}
		partitions = append(partitions, PartitionEntry{PartitionID: partitionID, NextSegmentID: nextSegmentID, Segments: segments})
	}
	return partitions
}

func (reader manifestReader) segments(entry *form.Fields, path string, partitionID uint32) []SegmentRef {
	list := entry.List("segments")
	if len(list) > MaxSegmentsPerPartition {
		reader.root.Fail(path+".segments", "lists "+strconv.Itoa(len(list))+" segments, above "+
			strconv.Itoa(MaxSegmentsPerPartition))
		return nil
	}
	seen := make(map[uint64]bool, len(list))
	segments := make([]SegmentRef, 0, len(list))
	for index := range list {
		at := indexed(path+".segments", index)
		raw := entry.Element(list, "segments", index)
		segment := SegmentRef{
			ID:             raw.Uint("id", MaxSegmentID),
			DocCount:       uint32(raw.Uint("docCount", math.MaxUint32)),
			TombstoneCount: uint32(raw.Uint("tombstoneCount", math.MaxUint32)),
		}
		if reader.root.Err() != nil {
			return nil
		}
		if seen[segment.ID] {
			reader.root.Fail(at+".id", "reuses segment id "+strconv.FormatUint(segment.ID, 10))
			return nil
		}
		seen[segment.ID] = true
		segment.File = reader.fileRef(raw, at, SegmentKey(reader.mode.indexName, partitionID, segment.ID), "segment")
		segments = append(segments, segment)
	}
	return segments
}

func (reader manifestReader) fileRef(raw *form.Fields, path string, expectedKey string, what string) FileRef {
	key, _ := raw.Value("key").(string)
	if reader.root.Err() == nil && key != expectedKey {
		reader.root.Fail(path+".key", "lists the "+what+" under the key \""+key+"\" where it belongs at \""+expectedKey+"\"")
	}
	ref := FileRef{Key: expectedKey}
	if !reader.mode.placement || reader.root.Err() != nil {
		return ref
	}
	ref.Bytes = raw.Uint("bytes", envelope.MaxFileBytes)
	if reader.root.Err() == nil && ref.Bytes < envelope.HeaderBytes {
		reader.root.Fail(path+".bytes", "gives the "+what+" \""+expectedKey+"\" a length shorter than its header")
	}
	ref.Checksum = uint32(raw.Uint("checksum", math.MaxUint32))
	if !raw.Has("headOffset") || reader.root.Err() != nil {
		return ref
	}
	head := Head{
		Offset:   raw.Uint("headOffset", form.MaxSafeInteger),
		Length:   uint32(raw.Uint("headLength", math.MaxUint32)),
		Checksum: uint32(raw.Uint("headChecksum", math.MaxUint32)),
	}
	if reader.root.Err() == nil && head.Offset+uint64(head.Length) > ref.Bytes-envelope.HeaderBytes {
		reader.root.Fail(path, "ends the head of the "+what+" \""+expectedKey+"\" outside its payload")
	}
	ref.Head = model.Some(head)
	return ref
}
