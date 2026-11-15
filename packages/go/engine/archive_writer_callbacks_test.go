package engine_test

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"testing"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const archiveCopyIndex = "archive-copy"

type callingWriter struct {
	bytes.Buffer
	called bool
	act    func() error
	err    error
}

func (w *callingWriter) Write(data []byte) (int, error) {
	if !w.called {
		w.called = true
		w.err = w.act()
	}
	return w.Buffer.Write(data)
}

type archiveRoute struct {
	write func(narsil *engine.Narsil, destination io.Writer) error
	read  func(narsil *engine.Narsil, indexName string, written []byte) error
}

func archiveRoutes() map[string]archiveRoute {
	ctx := context.Background()
	return map[string]archiveRoute{
		"snapshot": {
			write: func(narsil *engine.Narsil, destination io.Writer) error {
				return narsil.Snapshot(ctx, callbackIndex, engine.SnapshotOptions{}, destination)
			},
			read: func(narsil *engine.Narsil, indexName string, written []byte) error {
				return restoreArchive(narsil, indexName, written)
			},
		},
		"export": {
			write: func(narsil *engine.Narsil, destination io.Writer) error {
				return narsil.ExportDocuments(ctx, callbackIndex, destination)
			},
			read: func(narsil *engine.Narsil, indexName string, written []byte) error {
				_, err := narsil.ImportDocumentExport(ctx, indexName, bytes.NewReader(written))
				return err
			},
		},
	}
}

func onlyLighthouse(narsil *engine.Narsil, ctx context.Context, indexName string) error {
	result, err := narsil.Query(ctx, indexName, engine.QueryParams{Term: "lighthouse"})
	if err != nil {
		return err
	}
	if result.Count != 1 || len(result.Hits) != 1 || result.Hits[0].ID != "kept" {
		return fmt.Errorf("index %s returned %+v", indexName, result)
	}
	return nil
}

func TestAnArchiveWriterCanCloseAndSearchItsIndex(t *testing.T) {
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
			if _, err := narsil.Insert(ctx, callbackIndex, engine.NewDocument().Set("title", "lighthouse"), "kept", engine.InsertOptions{}); err != nil {
				t.Fatal(err)
			}
			writer := &callingWriter{act: func() error {
				bounded, cancel := context.WithTimeout(ctx, callbackDeadline/2)
				defer cancel()
				if err := narsil.Close(bounded, callbackIndex); err != nil {
					return err
				}
				return onlyLighthouse(narsil, bounded, callbackIndex)
			}}
			if _, err := finishedWithin(t, name, func() (struct{}, error) { return struct{}{}, route.write(narsil, writer) }); err != nil {
				t.Fatalf("the %s failed with %s: %v", name, codeOrMessage(err), err)
			}
			if !writer.called || writer.err != nil {
				t.Fatalf("the writer called=%t and its close and search returned %v", writer.called, writer.err)
			}
			if err := route.read(narsil, archiveCopyIndex, writer.Bytes()); err != nil {
				t.Fatalf("reading the %s back failed with %s: %v", name, codeOrMessage(err), err)
			}
			if err := onlyLighthouse(narsil, ctx, archiveCopyIndex); err != nil {
				t.Fatal(err)
			}
		})
	}
}
