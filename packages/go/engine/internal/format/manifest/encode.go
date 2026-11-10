package manifest

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/envelope"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/form"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type treeMode uint8

const (
	treeMessagePack treeMode = iota
	treeJSON
	treeArchiveJSON
)

func number[T ~uint8 | ~uint32 | ~uint64](value T) float64 {
	return float64(value)
}

func entry(key string, value any) codec.MapEntry {
	return codec.MapEntry{Key: key, Value: value}
}

func (ref FileRef) entries(mode treeMode) codec.OrderedMap {
	entries := codec.OrderedMap{entry("key", ref.Key)}
	if mode == treeArchiveJSON {
		return entries
	}
	entries = append(entries, entry("bytes", number(ref.Bytes)), entry("checksum", number(ref.Checksum)))
	if head, present := ref.Head.Get(); present {
		entries = append(entries, entry("headOffset", number(head.Offset)), entry("headLength", number(head.Length)),
			entry("headChecksum", number(head.Checksum)))
	}
	return entries
}

func deadValue(file VectorFileRef, mode treeMode) any {
	dead, marked := file.Dead.Get()
	if !marked {
		return nil
	}
	if mode == treeMessagePack {
		return dead
	}
	return form.Values(dead, form.WidthUint8)
}

func (field VectorFieldRef) tree(mode treeMode) codec.OrderedMap {
	files := make([]any, len(field.Files))
	for index, file := range field.Files {
		ref := file.File.entries(mode)
		values := codec.OrderedMap{entry("id", number(file.ID)), ref[0]}
		values = append(values, ref[1:]...)
		files[index] = append(values, entry("count", number(file.Count)), entry("dead", deadValue(file, mode)))
	}
	parts := make([]any, len(field.GraphParts))
	for index, part := range field.GraphParts {
		parts[index] = part.entries(mode)
	}
	return codec.OrderedMap{
		entry("fieldPath", field.FieldPath),
		entry("nextFileId", number(field.NextFileID)),
		entry("files", files),
		entry("graphGeneration", number(field.GraphGeneration)),
		entry("graphParts", parts),
	}
}

func (checkpoint PartitionCheckpoint) tree() codec.OrderedMap {
	values := codec.OrderedMap{
		entry("partitionId", number(checkpoint.PartitionID)),
		entry("lastSeqNo", number(checkpoint.LastSeqNo)),
		entry("primaryTerm", number(checkpoint.PrimaryTerm)),
	}
	history, present := checkpoint.TermHistory.Get()
	if !present {
		return values
	}
	starts := make([]any, len(history))
	for index, start := range history {
		starts[index] = codec.OrderedMap{
			entry("primaryTerm", number(start.PrimaryTerm)),
			entry("firstSeqNo", number(start.FirstSeqNo)),
		}
	}
	return append(values, entry("termHistory", starts))
}

func (partition PartitionEntry) tree(mode treeMode) codec.OrderedMap {
	segments := make([]any, len(partition.Segments))
	for index, segment := range partition.Segments {
		file := segment.File
		if mode == treeMessagePack {
			file.Head = model.Optional[Head]{}
		}
		ref := file.entries(mode)
		values := codec.OrderedMap{entry("id", number(segment.ID)), ref[0],
			entry("docCount", number(segment.DocCount)), entry("tombstoneCount", number(segment.TombstoneCount))}
		segments[index] = append(values, ref[1:]...)
	}
	return codec.OrderedMap{
		entry("partitionId", number(partition.PartitionID)),
		entry("nextSegmentId", number(partition.NextSegmentID)),
		entry("segments", segments),
	}
}

func (manifest Manifest) tree(mode treeMode) codec.OrderedMap {
	values := codec.OrderedMap{
		entry("version", float64(Version)),
		entry("schema", form.SchemaEntries(manifest.Schema, manifest.SchemaOrder)),
		entry("language", manifest.Language),
	}
	if manifest.AnalysisGeneration != 0 {
		values = append(values, entry("analysisGeneration", number(manifest.AnalysisGeneration)))
	}
	checkpoints := make([]any, len(manifest.Checkpoint))
	for index, checkpoint := range manifest.Checkpoint {
		checkpoints[index] = checkpoint.tree()
	}
	partitions := make([]any, len(manifest.Partitions))
	for index, partition := range manifest.Partitions {
		partitions[index] = partition.tree(mode)
	}
	vectors := make([]any, len(manifest.Vectors))
	for index, field := range manifest.Vectors {
		vectors[index] = field.tree(mode)
	}
	return append(values, entry("checkpoint", checkpoints), entry("partitions", partitions), entry("vectors", vectors))
}

func EncodePayload(manifest Manifest, indexName string) ([]byte, error) {
	payload, err := codec.Marshal(manifest.tree(treeMessagePack), codec.EncodeOptions{
		ErrorCode: narsilerr.CodePersistenceSaveFailed,
	})
	if err != nil {
		return nil, err
	}
	decoded, err := codec.Unmarshal(payload, codec.DecodeOptions{ErrorCode: narsilerr.CodePersistenceSaveFailed})
	if err != nil {
		return nil, err
	}
	record, _ := decoded.(map[string]any)
	if _, err := FromPayload(record, indexName); err != nil {
		return nil, narsilerr.Wrap(narsilerr.CodePersistenceSaveFailed,
			"The segment manifest breaks a rule that a reader applies", err, nil)
	}
	return payload, nil
}

func Encode(manifest Manifest, indexName string, gzip bool) ([]byte, error) {
	payload, err := EncodePayload(manifest, indexName)
	if err != nil {
		return nil, err
	}
	return envelope.Pack(payload, envelope.PackOptions{
		FormatVersion: EnvelopeVersion,
		What:          EnvelopeKind.What,
		Gzip:          gzip,
		Checksum:      true,
	})
}
