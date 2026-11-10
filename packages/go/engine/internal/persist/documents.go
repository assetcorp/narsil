package persist

import (
	"encoding/binary"
	"math"
	"slices"
	"sort"
	"strings"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/wal"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type Write struct {
	DocumentID string
	Document   map[string]any
	Encoded    []byte
	Vectors    map[string][]float32
}

func (write Write) deletes() bool {
	return write.Document == nil
}

func sortedKeys[V any](held map[string]V) []string {
	keys := make([]string, 0, len(held))
	for key := range held {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func nestedHolder(document *codec.Document, segments []string, createsMissing bool) *codec.Document {
	holder := document
	for _, segment := range segments[:len(segments)-1] {
		held, _ := codec.HeldValue(holder, segment)
		nested, isDocument := held.(*codec.Document)
		if !isDocument || nested == nil {
			if !createsMissing {
				return nil
			}
			nested = codec.NewDocument()
			holder.Set(segment, nested)
		}
		holder = nested
	}
	return holder
}

func storedWithVectors(stored []byte, vectors map[string][]float32) ([]byte, error) {
	if len(vectors) == 0 {
		return stored, nil
	}
	document, err := codec.DecodeStoredDocument(stored, codec.DecodeOptions{ErrorCode: narsilerr.CodeDocValidationFailed})
	if err != nil {
		return nil, err
	}
	for _, path := range sortedKeys(vectors) {
		segments := strings.Split(path, ".")
		nestedHolder(document, segments, true).Set(segments[len(segments)-1], vectors[path])
	}
	return codec.EncodeDocument(document)
}

func storedWithoutVectors(logged []byte, paths map[string]int) ([]byte, error) {
	document, err := codec.DecodeStoredDocument(logged, codec.DecodeOptions{ErrorCode: narsilerr.CodePersistenceWalCorrupt})
	if err != nil {
		return nil, err
	}
	for _, path := range sortedKeys(paths) {
		segments := strings.Split(path, ".")
		if holder := nestedHolder(document, segments, false); holder != nil {
			holder.Delete(segments[len(segments)-1])
		}
	}
	if stored, unchanged := codec.StoredBytes(document); unchanged {
		return stored, nil
	}
	return codec.EncodeDocument(document)
}

func vectorOf(value any) ([]float32, bool) {
	switch typed := value.(type) {
	case []float32:
		return typed, true
	case []byte:
		if len(typed)%4 != 0 {
			return nil, false
		}
		values := make([]float32, len(typed)/4)
		for at := range values {
			values[at] = math.Float32frombits(binary.LittleEndian.Uint32(typed[at*4:]))
		}
		return values, true
	case []any:
		values := make([]float32, len(typed))
		for at, item := range typed {
			number, isNumber := item.(float64)
			if !isNumber {
				return nil, false
			}
			values[at] = float32(number)
		}
		return values, true
	}
	return nil, false
}

func stripVectors(document map[string]any, paths map[string]int) (map[string]any, map[string][]float32) {
	vectors := map[string][]float32{}
	for path := range paths {
		segments := strings.Split(path, ".")
		holder := document
		for _, segment := range segments[:len(segments)-1] {
			next, isMap := holder[segment].(map[string]any)
			if !isMap {
				holder = nil
				break
			}
			holder = next
		}
		if holder == nil {
			continue
		}
		leaf := segments[len(segments)-1]
		raw, present := holder[leaf]
		if !present {
			continue
		}
		delete(holder, leaf)
		if values, isVector := vectorOf(raw); isVector {
			vectors[path] = values
		}
	}
	return document, vectors
}

func entryFor(write Write, indexName string, partitionID uint32, seqNo uint64) (wal.Entry, error) {
	entry := wal.Entry{SeqNo: seqNo, PrimaryTerm: SingleNodePrimaryTerm, PartitionID: partitionID,
		IndexName: indexName, DocumentID: write.DocumentID, Operation: wal.OperationDelete}
	if !write.deletes() {
		stored := write.Encoded
		if stored == nil {
			encoded, err := codec.EncodeDocument(write.Document)
			if err != nil {
				return entry, err
			}
			stored = encoded
		}
		logged, err := storedWithVectors(stored, write.Vectors)
		if err != nil {
			return entry, err
		}
		entry.Operation = wal.OperationIndex
		entry.Document = logged
	}
	return wal.Build(entry), nil
}

func writeOfEntry(entry wal.Entry, vectorPaths map[string]int) (Write, error) {
	if entry.Operation == wal.OperationDelete {
		return Write{DocumentID: entry.DocumentID}, nil
	}
	if entry.Document == nil {
		return Write{}, narsilerr.New(narsilerr.CodePersistenceWalCorrupt,
			`The log record for document "`+entry.DocumentID+`" indexes no document`,
			map[string]any{"seqNo": entry.SeqNo})
	}
	document, err := codec.DecodeDocument(entry.Document,
		codec.DecodeOptions{ErrorCode: narsilerr.CodePersistenceWalCorrupt})
	if err != nil {
		return Write{}, err
	}
	if len(vectorPaths) == 0 {
		return Write{DocumentID: entry.DocumentID, Document: document, Encoded: slices.Clone(entry.Document),
			Vectors: map[string][]float32{}}, nil
	}
	stored, err := storedWithoutVectors(entry.Document, vectorPaths)
	if err != nil {
		return Write{}, err
	}
	stripped, vectors := stripVectors(document, vectorPaths)
	return Write{DocumentID: entry.DocumentID, Document: stripped, Encoded: stored, Vectors: vectors}, nil
}
