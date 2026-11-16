package index

import (
	"context"
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/analysis"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partition"
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

func (ix *Index) PrepareBatch(kind WriteKind, writes []DocumentWrite, tokens *analysis.Pass) *Batch {
	batch := &Batch{kind: kind, writes: writes, Failures: make([]error, len(writes))}
	if kind == WriteRemove {
		return batch
	}
	batch.prepared, batch.Failures = ix.prepare(writes, tokens)
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
	return ix.ApplyWith(context.Background(), kind, writes, vectors, nil, nil)
}

func (ix *Index) ApplyWith(ctx context.Context, kind WriteKind, writes []DocumentWrite, vectors []vector.NamedField,
	tokens *analysis.Pass, stored *StoredRead) ([]error, error) {
	if !ix.KeepsTokensOf(tokens) {
		tokens = nil
	}
	kept := keptWrite(tokens)
	if len(vectors) > 0 || kind != WriteInsert && kept == nil && ix.settings.Analyzer.CallsCallerCode() {
		batch := ix.PrepareBatch(kind, writes, kept)
		applied := false
		err := ix.Write(ctx, func(w *Write) error {
			applied = true
			w.write.Tokens = kept
			w.write.Stored = stored.documentsFor(ix, w)
			return w.ApplyBatch(batch, vectors)
		})
		if !applied {
			refuseUnwritten(batch.Failures, err)
		}
		ix.noteGrowth()
		return batch.Failures, err
	}
	failures := make([]error, len(writes))
	var err error
	for start := 0; start < len(writes) && err == nil; start += InPlaceWriteChunkDocuments {
		end := min(start+InPlaceWriteChunkDocuments, len(writes))
		batch := ix.PrepareBatch(kind, writes[start:end], kept)
		applied := false
		err = ix.sides.WriteInPlace(ctx, func(write *partition.Write) error {
			applied = true
			w := &Write{ix: ix, write: write}
			write.Tokens = kept
			write.Stored = stored.documentsFor(ix, w)
			return w.ApplyBatch(batch, nil)
		})
		if !applied {
			refuseUnwritten(batch.Failures, err)
		}
		copy(failures[start:end], batch.Failures)
		if err != nil {
			refuseUnwritten(failures[end:], err)
		}
	}
	ix.noteGrowth()
	return failures, err
}

func refuseUnwritten(failures []error, err error) {
	for at := range failures {
		if failures[at] == nil {
			failures[at] = err
		}
	}
}
