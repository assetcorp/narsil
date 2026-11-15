package engine_test

import (
	"context"
	"fmt"
	"testing"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	archivedDocuments  = 300
	changedWhileStream = 50
)

func archivedID(at int) string {
	return fmt.Sprintf("doc-%03d", at)
}

func writeDuringArchive(ctx context.Context, narsil *engine.Narsil) error {
	for at := range changedWhileStream {
		update := engine.NewDocument().Set("title", fmt.Sprintf("rewritten %d", at))
		if err := narsil.Update(ctx, callbackIndex, archivedID(at), update, engine.WriteOptions{}); err != nil {
			return err
		}
		if err := narsil.Remove(ctx, callbackIndex, archivedID(changedWhileStream+at), engine.WriteOptions{}); err != nil {
			return err
		}
		added := engine.NewDocument().Set("title", fmt.Sprintf("arrived %d", at))
		if _, err := narsil.Insert(ctx, callbackIndex, added, fmt.Sprintf("new-%03d", at), engine.InsertOptions{}); err != nil {
			return err
		}
	}
	if err := narsil.Checkpoint(ctx, callbackIndex); err != nil {
		return err
	}
	if err := narsil.Close(ctx, callbackIndex); err != nil {
		return err
	}
	return narsil.Checkpoint(ctx, callbackIndex)
}

func requireTitles(t *testing.T, narsil *engine.Narsil, indexName string, expected map[string]string, absent []string) {
	t.Helper()
	ctx := context.Background()
	stats, err := narsil.GetStats(indexName)
	if err != nil || stats.DocumentCount != len(expected) {
		t.Fatalf("index %s holds %d documents, %v; the reference holds %d", indexName, stats.DocumentCount, err, len(expected))
	}
	for id, title := range expected {
		document, found, err := narsil.Get(ctx, indexName, id)
		if err != nil || !found {
			t.Fatalf("index %s lost %s: found=%t, %v", indexName, id, found, err)
		}
		held, _ := document.Get("title")
		if held != title {
			t.Fatalf("index %s gives %s the title %v; the reference gives %q", indexName, id, held, title)
		}
	}
	for _, id := range absent {
		if _, found, err := narsil.Get(ctx, indexName, id); err != nil || found {
			t.Fatalf("index %s holds %s, which arrived after the archive began: found=%t, %v", indexName, id, found, err)
		}
	}
}

func TestAnArchiveKeepsItsContentsWhileWritesContinue(t *testing.T) {
	for name, route := range archiveRoutes() {
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			narsil, err := engine.New(ctx, engine.Config{
				Workers:    engine.WorkerConfig{Enabled: engine.Some(false)},
				Durability: &engine.DurabilityConfig{Directory: t.TempDir(), Mode: engine.DurabilitySync},
			})
			if err != nil {
				t.Fatal(err)
			}
			defer func() {
				bounded, cancel := context.WithTimeout(ctx, callbackDeadline)
				defer cancel()
				if err := narsil.Shutdown(bounded); err != nil {
					t.Errorf("the engine did not shut down after the %s: %v", name, err)
				}
			}()
			if err := narsil.CreateIndex(ctx, callbackIndex, engine.IndexConfig{Schema: engine.Schema{"title": engine.FieldString}}); err != nil {
				t.Fatal(err)
			}
			reference := make(map[string]string, archivedDocuments)
			documents := make([]*engine.Document, archivedDocuments)
			for at := range documents {
				reference[archivedID(at)] = fmt.Sprintf("harbour %d", at)
				documents[at] = engine.NewDocument().Set("id", archivedID(at)).Set("title", reference[archivedID(at)])
			}
			if result, err := narsil.InsertBatch(ctx, callbackIndex, documents, engine.InsertOptions{}); err != nil || len(result.Failed) != 0 {
				t.Fatalf("the insert returned %+v, %v", result, err)
			}
			writer := &callingWriter{act: func() error {
				bounded, cancel := context.WithTimeout(ctx, callbackDeadline/2)
				defer cancel()
				return writeDuringArchive(bounded, narsil)
			}}
			if _, err := finishedWithin(t, name, func() (struct{}, error) { return struct{}{}, route.write(narsil, writer) }); err != nil {
				t.Fatalf("the %s failed with %s: %v", name, codeOrMessage(err), err)
			}
			if !writer.called || writer.err != nil {
				t.Fatalf("the writer called=%t and its writes returned %v", writer.called, writer.err)
			}
			if err := route.read(narsil, archiveCopyIndex, writer.Bytes()); err != nil {
				t.Fatalf("reading the %s back failed with %s: %v", name, codeOrMessage(err), err)
			}
			arrived := make([]string, changedWhileStream)
			live := make(map[string]string, archivedDocuments)
			for id, title := range reference {
				live[id] = title
			}
			for at := range changedWhileStream {
				arrived[at] = fmt.Sprintf("new-%03d", at)
				live[archivedID(at)] = fmt.Sprintf("rewritten %d", at)
				delete(live, archivedID(changedWhileStream+at))
				live[arrived[at]] = fmt.Sprintf("arrived %d", at)
			}
			requireTitles(t, narsil, archiveCopyIndex, reference, arrived)
			requireTitles(t, narsil, callbackIndex, live, nil)
		})
	}
}
