package earlier

import (
	"strings"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/envelope"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

const (
	SnapshotEnvelopeVersion = 2
	vectorTypePrefix        = "vector["
	vectorTypeSuffix        = "]"
)

type Segment struct {
	Payload    []byte
	Tombstones []string
}

type PartitionDocuments struct {
	Schema    map[string]string
	Documents map[string]map[string]any
}

func loadFailed(message string) error {
	return narsilerr.New(narsilerr.CodePersistenceLoadFailed, message, nil)
}

func DecodeSegment(data []byte) (Segment, error) {
	opened, err := envelope.OpenUpTo(data, SnapshotEnvelopeVersion, "segment file of the earlier layout")
	if err != nil {
		return Segment{}, err
	}
	decoded, err := codec.Unmarshal(opened.Payload, codec.DecodeOptions{ErrorCode: narsilerr.CodePersistenceLoadFailed})
	if err != nil {
		return Segment{}, err
	}
	record, _ := decoded.(map[string]any)
	payload, isBytes := record["payload"].([]byte)
	if !isBytes {
		return Segment{}, loadFailed("Segment file is missing its partition payload")
	}
	segment := Segment{Payload: payload}
	raw, present := record["tombstones"]
	if !present {
		return segment, nil
	}
	list, isList := raw.([]any)
	if !isList {
		return Segment{}, loadFailed("Segment file has a malformed tombstone list")
	}
	segment.Tombstones = make([]string, 0, len(list))
	for _, element := range list {
		docID, isString := element.(string)
		if !isString {
			return Segment{}, loadFailed("Segment file has a malformed tombstone list")
		}
		segment.Tombstones = append(segment.Tombstones, docID)
	}
	return segment, nil
}

func isVectorType(typeName string) bool {
	if !strings.HasPrefix(typeName, vectorTypePrefix) || !strings.HasSuffix(typeName, vectorTypeSuffix) {
		return false
	}
	digits := typeName[len(vectorTypePrefix) : len(typeName)-len(vectorTypeSuffix)]
	if digits == "" {
		return false
	}
	for index := 0; index < len(digits); index++ {
		if digits[index] < '0' || digits[index] > '9' {
			return false
		}
	}
	return true
}

func removeFieldAtPath(fields map[string]any, fieldPath string) {
	segments := strings.Split(fieldPath, ".")
	current := fields
	for _, segment := range segments[:len(segments)-1] {
		next, isMap := current[segment].(map[string]any)
		if !isMap {
			return
		}
		current = next
	}
	delete(current, segments[len(segments)-1])
}

func readPayloadKeys(payload []byte) (map[string]any, error) {
	decoder := codec.NewDecoder(payload, codec.DecodeOptions{ErrorCode: narsilerr.CodePersistenceLoadFailed})
	count, err := decoder.ReadMapHeader()
	if err != nil {
		return nil, err
	}
	kept := make(map[string]any, 2)
	for range count {
		key, err := decoder.ReadString()
		if err != nil {
			return nil, err
		}
		if key != "schema" && key != "documents" {
			if err := decoder.Skip(); err != nil {
				return nil, err
			}
			continue
		}
		if kept[key], err = decoder.ReadValue(); err != nil {
			return nil, err
		}
	}
	if decoder.More() {
		return nil, decoder.Errorf("The partition payload holds %d bytes after its map", decoder.Remaining())
	}
	return kept, nil
}

func DecodePartitionDocuments(payload []byte) (PartitionDocuments, error) {
	kept, err := readPayloadKeys(payload)
	if err != nil {
		return PartitionDocuments{}, err
	}
	rawSchema, _ := kept["schema"].(map[string]any)
	if err := schema.RequireValidFieldTypes(rawSchema); err != nil {
		return PartitionDocuments{}, err
	}
	decoded := PartitionDocuments{Schema: make(map[string]string, len(rawSchema))}
	var vectorPaths []string
	for path, value := range rawSchema {
		typeName, _ := value.(string)
		decoded.Schema[path] = typeName
		if isVectorType(typeName) {
			vectorPaths = append(vectorPaths, path)
		}
	}
	rawDocuments, _ := kept["documents"].(map[string]any)
	if kept["documents"] != nil && rawDocuments == nil {
		return PartitionDocuments{}, loadFailed("The partition payload holds documents that are not a map")
	}
	decoded.Documents = make(map[string]map[string]any, len(rawDocuments))
	for docID, stored := range rawDocuments {
		record, _ := stored.(map[string]any)
		fields, isMap := record["fields"].(map[string]any)
		if !isMap {
			return PartitionDocuments{}, loadFailed("The partition payload holds document \"" + docID + "\" without a map of fields")
		}
		for _, path := range vectorPaths {
			removeFieldAtPath(fields, path)
		}
		decoded.Documents[docID] = fields
	}
	return decoded, nil
}
