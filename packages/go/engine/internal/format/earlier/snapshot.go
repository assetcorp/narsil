package earlier

import (
	"sort"
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/envelope"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/form"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

const (
	BundleVersion                = 2
	IndexSnapshotEnvelopeVersion = 3
	indexSnapshotVersionOne      = 1
	indexSnapshotVersionTwo      = 2
)

type Bundle struct {
	Schema        map[string]string
	Language      string
	Partitions    [][]byte
	VectorIndexes []VectorField
	Checkpoint    []manifest.PartitionCheckpoint
}

type IndexSnapshot struct {
	Version       uint8
	Schema        map[string]string
	Language      string
	Partitions    [][]byte
	VectorIndexes []VectorField
	Payload       map[string]any
}

type VectorField struct {
	FieldPath string
	Parts     []VectorIndexPart
}

func partitionBytes(raw any) ([][]byte, bool) {
	list, isList := raw.([]any)
	if !isList {
		return nil, false
	}
	partitions := make([][]byte, 0, len(list))
	for _, element := range list {
		bytes, isBytes := element.([]byte)
		if !isBytes {
			return nil, false
		}
		partitions = append(partitions, bytes)
	}
	return partitions, true
}

func requirePartitionCount(count int, what string) error {
	if count <= MaxPartitionCount {
		return nil
	}
	return loadFailed("The " + what + " holds " + strconv.Itoa(count) + " partitions, above the limit of " +
		strconv.Itoa(MaxPartitionCount))
}

func vectorFields(raw any, code string) ([]VectorField, error) {
	if raw == nil {
		return nil, nil
	}
	record, isMap := raw.(map[string]any)
	if !isMap {
		return nil, narsilerr.New(code, "The vector indexes of the earlier layout are not a map", nil)
	}
	paths := make([]string, 0, len(record))
	for path := range record {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	fields := make([]VectorField, 0, len(paths))
	for _, path := range paths {
		parts, err := DecodeVectorIndexParts(record[path])
		if err != nil {
			return nil, err
		}
		fields = append(fields, VectorField{FieldPath: path, Parts: parts})
	}
	return fields, nil
}

func DecodeBundle(data []byte) (Bundle, error) {
	opened, err := envelope.OpenUpTo(data, SnapshotEnvelopeVersion, "snapshot bundle")
	if err != nil {
		return Bundle{}, err
	}
	decoded, err := codec.Unmarshal(opened.Payload, codec.DecodeOptions{ErrorCode: narsilerr.CodePersistenceLoadFailed})
	if err != nil {
		return Bundle{}, err
	}
	payload, _ := decoded.(map[string]any)
	if version, _ := payload["version"].(float64); version != BundleVersion {
		return Bundle{}, narsilerr.New(narsilerr.CodeEnvelopeVersionMismatch,
			"The snapshot bundle holds a layout other than "+strconv.Itoa(BundleVersion)+
				", which this release cannot open. Export the index with the release that wrote it and import the export",
			map[string]any{"version": payload["version"]})
	}
	fields := form.NewFields(payload, "", narsilerr.CodePersistenceLoadFailed, "snapshot bundle")
	flat, err := flatSchema(payload, fields)
	if err != nil {
		return Bundle{}, err
	}
	bundle := Bundle{Schema: flat, Language: fields.String("language")}
	if fields.Err() != nil {
		return Bundle{}, fields.Err()
	}
	partitions, valid := partitionBytes(payload["partitions"])
	if !valid {
		return Bundle{}, loadFailed("Snapshot bundle is missing its partitions")
	}
	if err := requirePartitionCount(len(partitions), "snapshot bundle"); err != nil {
		return Bundle{}, err
	}
	bundle.Partitions = partitions
	if bundle.VectorIndexes, err = vectorFields(payload["vectorIndexes"], narsilerr.CodePersistenceLoadFailed); err != nil {
		return Bundle{}, err
	}
	bundle.Checkpoint = lenientCheckpoints(payload["checkpoint"])
	return bundle, nil
}

func invalidSnapshot(message string) error {
	return narsilerr.New(narsilerr.CodeDocValidationFailed, message, nil)
}

func DecodeIndexSnapshot(data []byte) (IndexSnapshot, error) {
	opened, err := envelope.OpenUpTo(data, IndexSnapshotEnvelopeVersion, "index snapshot")
	if err != nil {
		return IndexSnapshot{}, err
	}
	if opened.Header.FormatVersion != IndexSnapshotEnvelopeVersion {
		return IndexSnapshot{}, narsilerr.New(narsilerr.CodeEnvelopeVersionMismatch,
			"Expected an index snapshot envelope of format v"+strconv.Itoa(IndexSnapshotEnvelopeVersion)+
				", received format v"+strconv.Itoa(int(opened.Header.FormatVersion)), nil)
	}
	decoded, err := codec.Unmarshal(opened.Payload, codec.DecodeOptions{ErrorCode: narsilerr.CodeDocValidationFailed})
	if err != nil {
		return IndexSnapshot{}, narsilerr.Wrap(narsilerr.CodeDocValidationFailed,
			"Snapshot data is not a Narsil snapshot", err, nil)
	}
	payload, isMap := decoded.(map[string]any)
	if !isMap {
		return IndexSnapshot{}, invalidSnapshot("Snapshot data does not hold a snapshot envelope")
	}
	version, _ := payload["version"].(float64)
	if version != indexSnapshotVersionOne && version != indexSnapshotVersionTwo {
		return IndexSnapshot{}, invalidSnapshot("Unsupported snapshot version. Expected version 1 or 2")
	}
	rawSchema, isSchema := payload["schema"].(map[string]any)
	if !isSchema {
		return IndexSnapshot{}, invalidSnapshot("Invalid snapshot: missing or invalid schema")
	}
	if err := schema.RequireValidFieldTypes(rawSchema); err != nil {
		return IndexSnapshot{}, err
	}
	language, isLanguage := payload["language"].(string)
	if !isLanguage || language == "" {
		return IndexSnapshot{}, invalidSnapshot("Invalid snapshot: missing or invalid language")
	}
	partitions, valid := partitionBytes(payload["partitions"])
	if !valid {
		return IndexSnapshot{}, invalidSnapshot("Invalid snapshot: missing partitions")
	}
	if err := requirePartitionCount(len(partitions), "index snapshot"); err != nil {
		return IndexSnapshot{}, err
	}
	snapshot := IndexSnapshot{
		Version:    uint8(version),
		Schema:     make(map[string]string, len(rawSchema)),
		Language:   language,
		Partitions: partitions,
		Payload:    payload,
	}
	for path, value := range rawSchema {
		typeName, _ := value.(string)
		snapshot.Schema[path] = typeName
	}
	if snapshot.VectorIndexes, err = vectorFields(payload["vectorIndexes"], narsilerr.CodePersistenceLoadFailed); err != nil {
		return IndexSnapshot{}, err
	}
	return snapshot, nil
}
