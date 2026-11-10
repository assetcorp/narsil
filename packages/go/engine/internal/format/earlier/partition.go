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

type Document struct {
	ID     string
	Fields *codec.Document
}

type PartitionDocuments struct {
	Schema    map[string]string
	Documents []Document
}

var payloadDecoding = codec.DecodeOptions{ErrorCode: narsilerr.CodePersistenceLoadFailed}

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

func removeFieldAtPath(fields *codec.Document, fieldPath string) {
	segments := strings.Split(fieldPath, ".")
	current := fields
	for _, segment := range segments[:len(segments)-1] {
		held, _ := codec.HeldValue(current, segment)
		next, isDocument := held.(*codec.Document)
		if !isDocument || next == nil {
			return
		}
		current = next
	}
	current.Delete(segments[len(segments)-1])
}

func skippedValue(decoder *codec.Decoder, data []byte) ([]byte, error) {
	start := decoder.Position()
	if err := decoder.Skip(); err != nil {
		return nil, err
	}
	return data[start:decoder.Position()], nil
}

type payloadKeys struct {
	schema    any
	documents []byte
}

func readPayloadKeys(payload []byte) (payloadKeys, error) {
	decoder := codec.NewDecoder(payload, payloadDecoding)
	count, err := decoder.ReadMapHeader()
	if err != nil {
		return payloadKeys{}, err
	}
	var kept payloadKeys
	for range count {
		key, err := decoder.ReadString()
		if err != nil {
			return payloadKeys{}, err
		}
		switch key {
		case "schema":
			kept.schema, err = decoder.ReadValue()
		case "documents":
			kept.documents, err = skippedValue(decoder, payload)
		default:
			err = decoder.Skip()
		}
		if err != nil {
			return payloadKeys{}, err
		}
	}
	if decoder.More() {
		return payloadKeys{}, decoder.Errorf("The partition payload holds %d bytes after its map", decoder.Remaining())
	}
	return kept, nil
}

func fieldsOfRecord(decoder *codec.Decoder, data []byte, docID string) (*codec.Document, error) {
	missing := loadFailed("The partition payload holds document \"" + docID + "\" without a map of fields")
	count, err := decoder.ReadMapHeader()
	if err != nil {
		return nil, missing
	}
	var fields []byte
	for range count {
		key, err := decoder.ReadString()
		if err != nil {
			return nil, err
		}
		if key != "fields" {
			if err := decoder.Skip(); err != nil {
				return nil, err
			}
			continue
		}
		if fields, err = skippedValue(decoder, data); err != nil {
			return nil, err
		}
	}
	if fields == nil {
		return nil, missing
	}
	if _, err := codec.NewDecoder(fields, payloadDecoding).ReadMapHeader(); err != nil {
		return nil, missing
	}
	return codec.DecodeStoredDocument(fields, payloadDecoding)
}

func readDocuments(data []byte, vectorPaths []string) ([]Document, error) {
	decoder := codec.NewDecoder(data, payloadDecoding)
	if data == nil || decoder.TryReadNil() {
		return []Document{}, nil
	}
	count, err := decoder.ReadMapHeader()
	if err != nil {
		return nil, loadFailed("The partition payload holds documents that are not a map")
	}
	entries := make(codec.OrderedMap, 0, count)
	positions := make(map[string]int, count)
	for range count {
		docID, err := decoder.ReadString()
		if err != nil {
			return nil, err
		}
		fields, err := fieldsOfRecord(decoder, data, docID)
		if err != nil {
			return nil, err
		}
		for _, path := range vectorPaths {
			removeFieldAtPath(fields, path)
		}
		if position, seen := positions[docID]; seen {
			entries[position].Value = fields
			continue
		}
		positions[docID] = len(entries)
		entries = append(entries, codec.MapEntry{Key: docID, Value: fields})
	}
	documents := make([]Document, len(entries))
	for at, entry := range codec.InJavaScriptPropertyOrder(entries) {
		fields, _ := entry.Value.(*codec.Document)
		documents[at] = Document{ID: entry.Key, Fields: fields}
	}
	return documents, nil
}

func DecodePartitionDocuments(payload []byte) (PartitionDocuments, error) {
	kept, err := readPayloadKeys(payload)
	if err != nil {
		return PartitionDocuments{}, err
	}
	rawSchema, _ := kept.schema.(map[string]any)
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
	decoded.Documents, err = readDocuments(kept.documents, vectorPaths)
	return decoded, err
}
