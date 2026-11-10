package earlier

import (
	"strings"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/wal"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type Documents map[string]map[string]any

func (documents Documents) ApplySegment(segment Segment) error {
	stored, err := DecodePartitionDocuments(segment.Payload)
	if err != nil {
		return err
	}
	for _, docID := range segment.Tombstones {
		delete(documents, docID)
	}
	for docID, fields := range stored.Documents {
		documents[docID] = fields
	}
	return nil
}

func (documents Documents) ApplyPartition(payload []byte) error {
	stored, err := DecodePartitionDocuments(payload)
	if err != nil {
		return err
	}
	for docID, fields := range stored.Documents {
		documents[docID] = fields
	}
	return nil
}

func (documents Documents) ApplyEntry(entry wal.Entry) error {
	if entry.Operation == wal.OperationDelete {
		delete(documents, entry.DocumentID)
		return nil
	}
	document, err := codec.DecodeDocument(entry.Document, codec.DecodeOptions{
		ErrorCode: narsilerr.CodePersistenceWalCorrupt,
	})
	if err != nil {
		return err
	}
	documents[entry.DocumentID] = document
	return nil
}

func setFieldAtPath(fields map[string]any, fieldPath string, value any) {
	segments := strings.Split(fieldPath, ".")
	current := fields
	for _, segment := range segments[:len(segments)-1] {
		next, isMap := current[segment].(map[string]any)
		if !isMap {
			next = map[string]any{}
			current[segment] = next
		}
		current = next
	}
	current[segments[len(segments)-1]] = value
}

func (documents Documents) AttachVectors(field VectorField) {
	for _, part := range field.Parts {
		for position, docID := range part.DocIDs {
			document, present := documents[docID]
			if !present {
				continue
			}
			setFieldAtPath(document, field.FieldPath, part.Vector(position))
		}
	}
}
