package persist

import (
	"encoding/binary"
	"math"
	"strings"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/wal"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type Write struct {
	DocumentID string
	Document   map[string]any
	Vectors    map[string][]float32
}

func (write Write) deletes() bool {
	return write.Document == nil
}

func withVectors(document map[string]any, vectors map[string][]float32) map[string]any {
	if len(vectors) == 0 {
		return document
	}
	copied := make(map[string]any, len(document)+len(vectors))
	for key, value := range document {
		copied[key] = value
	}
	for path, values := range vectors {
		segments := strings.Split(path, ".")
		holder := copied
		for _, segment := range segments[:len(segments)-1] {
			next, isMap := holder[segment].(map[string]any)
			nested := make(map[string]any, len(next)+1)
			if isMap {
				for key, value := range next {
					nested[key] = value
				}
			}
			holder[segment] = nested
			holder = nested
		}
		holder[segments[len(segments)-1]] = values
	}
	return copied
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
		encoded, err := codec.EncodeDocument(withVectors(write.Document, write.Vectors))
		if err != nil {
			return entry, err
		}
		entry.Operation = wal.OperationIndex
		entry.Document = encoded
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
	stripped, vectors := stripVectors(document, vectorPaths)
	return Write{DocumentID: entry.DocumentID, Document: stripped, Vectors: vectors}, nil
}
