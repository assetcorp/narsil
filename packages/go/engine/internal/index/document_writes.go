package index

import (
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/vector"
)

type WriteKind uint8

const (
	WriteInsert WriteKind = iota
	WriteUpdate
	WriteRemove
)

type DocumentWrite struct {
	ID       string
	Document *codec.Document
	Fields   map[string]any
	Encoded  []byte
	Vectors  map[string][]float32
}

var writtenDecoding = codec.DecodeOptions{ErrorCode: narsilerr.CodeDocValidationFailed}

func (write DocumentWrite) ordered() *codec.Document {
	switch {
	case write.Document != nil:
		return write.Document
	case write.Encoded != nil:
		return codec.NewStoredDocument(write.Encoded, writtenDecoding)
	case write.Fields != nil:
		return codec.DocumentFromMap(write.Fields)
	}
	return codec.NewDocument()
}

type Batch struct {
	kind     WriteKind
	writes   []DocumentWrite
	prepared []PreparedDocument
	Failures []error
}

func (ix *Index) PrepareBatch(kind WriteKind, writes []DocumentWrite) *Batch {
	batch := &Batch{kind: kind, writes: writes, Failures: make([]error, len(writes))}
	if kind == WriteRemove {
		return batch
	}
	batch.prepared, batch.Failures = ix.prepare(writes)
	return batch
}

func (b *Batch) ids() []string {
	ids := make([]string, len(b.writes))
	for at, write := range b.writes {
		ids[at] = write.ID
	}
	return ids
}

func (w *Write) keywords(b *Batch) error {
	var err error
	switch b.kind {
	case WriteRemove:
		b.Failures, err = w.Remove(b.ids(), b.Failures)
	case WriteInsert:
		b.Failures, err = w.Insert(b.prepared, b.Failures)
	default:
		b.Failures, err = w.Update(b.prepared, b.Failures)
	}
	return err
}

func (w *Write) vectorDocuments(b *Batch) []vector.DocumentVectors {
	documents := make([]vector.DocumentVectors, len(b.writes))
	for at, write := range b.writes {
		documents[at] = vector.DocumentVectors{DocID: write.ID, Vectors: write.Vectors,
			Partition: int32(w.ix.partitionOf(write.ID)), Remove: b.kind == WriteRemove}
	}
	return documents
}

func (w *Write) ApplyBatch(b *Batch, vectors []vector.NamedField) error {
	if err := w.keywords(b); err != nil || len(vectors) == 0 {
		return err
	}
	indexed := slices.Clone(b.Failures)
	vector.ApplyDocumentsAt(w.Sequence(), vectors, w.vectorDocuments(b), b.Failures)
	if b.kind != WriteInsert {
		return nil
	}
	var refused []string
	for at, write := range b.writes {
		if indexed[at] == nil && b.Failures[at] != nil {
			refused = append(refused, write.ID)
		}
	}
	if len(refused) == 0 {
		return nil
	}
	vector.ApplyDocumentsAt(w.Sequence(), vectors, vector.RemovalsOf(refused), make([]error, len(refused)))
	_, err := w.Remove(refused, nil)
	return err
}

func (ix *Index) Apply(kind WriteKind, writes []DocumentWrite, vectors []vector.NamedField) ([]error, error) {
	batch := ix.PrepareBatch(kind, writes)
	err := ix.Write(func(w *Write) error { return w.ApplyBatch(batch, vectors) })
	return batch.Failures, err
}
