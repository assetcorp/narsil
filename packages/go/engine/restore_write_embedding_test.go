package engine_test

import (
	"context"
	"slices"
	"sync/atomic"
	"testing"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	writeEmbeddingAdapter      = "writer"
	documentOnlyTheArchiveHeld = "restored-only"
	documentBothIndexesHeld    = "shared"
	documentTheRestoreReplaced = "replaced-only"
	updatedTitle               = "updated shared title"
)

var freshTitles = []string{"fresh first", "fresh second", "fresh third"}

type restoringWrite struct {
	name    string
	write   func(*engine.Narsil) error
	written map[string]string
}

func freshDocument(title string) *engine.Document {
	return engine.DocumentFromMap(map[string]any{"title": title})
}

func freshBatch() []*engine.Document {
	documents := make([]*engine.Document, len(freshTitles))
	for at, title := range freshTitles {
		documents[at] = engine.DocumentFromMap(map[string]any{"id": title, "title": title})
	}
	return documents
}

func freshWritten() map[string]string {
	written := map[string]string{}
	for _, title := range freshTitles {
		written[title] = title
	}
	return written
}

func requireWholeBatch(result engine.BatchResult, err error) error {
	if err != nil {
		return err
	}
	if len(result.Failed) > 0 {
		return result.Failed[0].Err
	}
	return nil
}

var restoringWrites = []restoringWrite{
	{name: "insert", written: map[string]string{freshTitles[0]: freshTitles[0]}, write: func(narsil *engine.Narsil) error {
		_, err := narsil.Insert(context.Background(), callbackIndex, freshDocument(freshTitles[0]), freshTitles[0],
			engine.InsertOptions{})
		return err
	}},
	{name: "update", written: map[string]string{documentBothIndexesHeld: updatedTitle}, write: func(narsil *engine.Narsil) error {
		return narsil.Update(context.Background(), callbackIndex, documentBothIndexesHeld, freshDocument(updatedTitle),
			engine.WriteOptions{})
	}},
	{name: "insert batch", written: freshWritten(), write: func(narsil *engine.Narsil) error {
		return requireWholeBatch(narsil.InsertBatch(context.Background(), callbackIndex, freshBatch(), engine.InsertOptions{}))
	}},
	{name: "update batch", written: map[string]string{documentBothIndexesHeld: updatedTitle}, write: func(narsil *engine.Narsil) error {
		updates := []engine.DocumentUpdate{{DocID: documentBothIndexesHeld, Document: freshDocument(updatedTitle)}}
		return requireWholeBatch(narsil.UpdateBatch(context.Background(), callbackIndex, updates, engine.WriteOptions{}))
	}},
}

func archiveForWrites(t *testing.T) []byte {
	t.Helper()
	source := startedForCallbacks(t, true)
	if err := source.RegisterEmbeddingAdapter(writeEmbeddingAdapter, fixedEmbedder(wantedVector)); err != nil {
		t.Fatalf("registering the source adapter failed: %v", err)
	}
	if err := source.CreateIndex(context.Background(), callbackIndex, embeddedTitleConfig(writeEmbeddingAdapter)); err != nil {
		t.Fatalf("the source refused the index with %s: %v", codeOrMessage(err), err)
	}
	insertTitled(t, source, documentOnlyTheArchiveHeld, wantedVector)
	insertTitled(t, source, documentBothIndexesHeld, wantedVector)
	return snapshotOf(t, source, callbackIndex)
}

func targetRestoringOnFirstEmbedding(t *testing.T, archive []byte) (*engine.Narsil, *atomic.Int32) {
	t.Helper()
	target := startedForCallbacks(t, true)
	var embeddings atomic.Int32
	restoring := &callbackEmbedder{dimensions: len(wantedVector), embed: func(string) ([]float32, error) {
		if embeddings.Add(1) == 1 {
			if err := restoreArchive(target, callbackIndex, archive); err != nil {
				return nil, err
			}
		}
		return append([]float32(nil), wantedVector...), nil
	}}
	if err := target.RegisterEmbeddingAdapter(writeEmbeddingAdapter, restoring); err != nil {
		t.Fatalf("registering the restoring adapter failed: %v", err)
	}
	if err := target.CreateIndex(context.Background(), callbackIndex, embeddedTitleConfig(writeEmbeddingAdapter)); err != nil {
		t.Fatalf("the target refused the index with %s: %v", codeOrMessage(err), err)
	}
	insertTitled(t, target, documentTheRestoreReplaced, decoyVector)
	insertTitled(t, target, documentBothIndexesHeld, decoyVector)
	return target, &embeddings
}

func requireStored(t *testing.T, narsil *engine.Narsil, id string, title string, vector []float32) {
	t.Helper()
	stored, found, err := narsil.Get(context.Background(), callbackIndex, id)
	if err != nil || !found {
		t.Fatalf("document %s is missing from the restored index: found %v, %v", id, found, err)
	}
	if held, _ := stored.Get("title"); held != title {
		t.Fatalf("document %s holds title %v, expected %q", id, held, title)
	}
	held, _ := stored.Get("embedding")
	if !slices.Equal(asVector(held), vector) {
		t.Fatalf("document %s holds embedding %v, expected %v", id, held, vector)
	}
}

func asVector(value any) []float32 {
	switch held := value.(type) {
	case []float32:
		return held
	case []any:
		vector := make([]float32, len(held))
		for at, element := range held {
			number, _ := element.(float64)
			vector[at] = float32(number)
		}
		return vector
	default:
		return nil
	}
}

func archiveBoundTo(t *testing.T, adapter string) []byte {
	t.Helper()
	source := startedForCallbacks(t, true)
	if err := source.RegisterEmbeddingAdapter(adapter, fixedEmbedder(wantedVector)); err != nil {
		t.Fatalf("registering the source adapter failed: %v", err)
	}
	if err := source.CreateIndex(context.Background(), callbackIndex, embeddedTitleConfig(adapter)); err != nil {
		t.Fatalf("the source refused the index with %s: %v", codeOrMessage(err), err)
	}
	insertTitled(t, source, documentOnlyTheArchiveHeld, wantedVector)
	return snapshotOf(t, source, callbackIndex)
}

func TestAWriteRefusesWithWorkerBusyOnceRestoresKeepChangingItsEmbeddingAdapter(t *testing.T) {
	archives := map[string][]byte{"first": archiveBoundTo(t, "second"), "second": archiveBoundTo(t, "first")}
	for _, kind := range restoringWrites {
		t.Run(kind.name, func(t *testing.T) {
			target := startedForCallbacks(t, true)
			var embeddings atomic.Int32
			for adapter, archive := range archives {
				restoring := &callbackEmbedder{dimensions: len(wantedVector), embed: func(string) ([]float32, error) {
					embeddings.Add(1)
					if err := restoreArchive(target, callbackIndex, archive); err != nil {
						return nil, err
					}
					return append([]float32(nil), wantedVector...), nil
				}}
				if err := target.RegisterEmbeddingAdapter(adapter, restoring); err != nil {
					t.Fatalf("registering adapter %s failed: %v", adapter, err)
				}
			}
			if err := target.CreateIndex(context.Background(), callbackIndex, embeddedTitleConfig("first")); err != nil {
				t.Fatalf("the target refused the index with %s: %v", codeOrMessage(err), err)
			}
			insertTitled(t, target, documentBothIndexesHeld, decoyVector)
			_, err := finishedWithin(t, "the "+kind.name, func() (struct{}, error) {
				return struct{}{}, kind.write(target)
			})
			if code := engine.ErrorCode(err); code != engine.CodeWorkerBusy {
				t.Fatalf("the %s returned %s, expected %s: %v", kind.name, codeOrMessage(err), engine.CodeWorkerBusy, err)
			}
			if got, expected := embeddings.Load(), int32(callbackRerunsRefused*len(kind.written)); got != expected {
				t.Fatalf("the %s embedded %d times, expected %d", kind.name, got, expected)
			}
			for id := range kind.written {
				if _, found, err := target.Get(context.Background(), callbackIndex, id); err != nil || found {
					t.Fatalf("the refused %s stored %s: found %v, %v", kind.name, id, found, err)
				}
			}
			requireStored(t, target, documentOnlyTheArchiveHeld, documentOnlyTheArchiveHeld, wantedVector)
		})
	}
}

func TestAWriteWhoseEmbeddingAdapterRestoresTheIndexLandsWholeInTheRestoredIndex(t *testing.T) {
	archive := archiveForWrites(t)
	for _, kind := range restoringWrites {
		t.Run(kind.name, func(t *testing.T) {
			target, embeddings := targetRestoringOnFirstEmbedding(t, archive)
			_, err := finishedWithin(t, "the "+kind.name, func() (struct{}, error) {
				return struct{}{}, kind.write(target)
			})
			if err != nil {
				t.Fatalf("the %s failed with %s: %v", kind.name, codeOrMessage(err), err)
			}
			if embeddings.Load() == 0 {
				t.Fatalf("the %s never called its embedding adapter", kind.name)
			}
			for id, title := range kind.written {
				requireStored(t, target, id, title, wantedVector)
			}
			requireStored(t, target, documentOnlyTheArchiveHeld, documentOnlyTheArchiveHeld, wantedVector)
			if _, found, err := target.Get(context.Background(), callbackIndex, documentTheRestoreReplaced); err != nil || found {
				t.Fatalf("the restored index holds %s, which only the replaced index held: found %v, %v",
					documentTheRestoreReplaced, found, err)
			}
			if _, isUpdate := kind.written[documentBothIndexesHeld]; !isUpdate {
				requireStored(t, target, documentBothIndexesHeld, documentBothIndexesHeld, wantedVector)
			}
			count, err := target.CountDocuments(context.Background(), callbackIndex)
			if err != nil {
				t.Fatalf("counting the restored index failed: %v", err)
			}
			expected := 2 + len(kind.written)
			if _, isUpdate := kind.written[documentBothIndexesHeld]; isUpdate {
				expected = 2
			}
			if count != expected {
				t.Fatalf("the restored index holds %d documents, expected %d", count, expected)
			}
		})
	}
}
