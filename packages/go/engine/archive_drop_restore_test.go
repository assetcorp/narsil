package engine_test

import (
	"context"
	"fmt"
	"slices"
	"testing"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const outerArchiveCopyIndex = "outer-archive-copy"

func topLevelEntries(t *testing.T, directory string) []string {
	t.Helper()
	names, err := topLevelNames(directory)
	if err != nil {
		t.Fatalf("listing %s failed: %v", directory, err)
	}
	return names
}

func engineIn(t *testing.T, directory string) *engine.Narsil {
	t.Helper()
	narsil, err := engine.New(context.Background(), engine.Config{
		Workers:    engine.WorkerConfig{Enabled: engine.Some(false)},
		Durability: &engine.DurabilityConfig{Directory: directory, Mode: engine.DurabilitySync},
	})
	if err != nil {
		t.Fatalf("the engine refused to open %s with %s: %v", directory, codeOrMessage(err), err)
	}
	return narsil
}

func shutDownWithin(t *testing.T, narsil *engine.Narsil, moment string) {
	t.Helper()
	bounded, cancel := context.WithTimeout(context.Background(), callbackDeadline)
	defer cancel()
	if err := narsil.Shutdown(bounded); err != nil {
		t.Fatalf("%s, the engine did not shut down: %v", moment, err)
	}
}

func harbourIndex(t *testing.T, narsil *engine.Narsil) map[string]string {
	t.Helper()
	ctx := context.Background()
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
	return reference
}

func TestAnArchiveWriterCanDropAndRestoreItsIndex(t *testing.T) {
	for name, route := range archiveRoutes() {
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			directory := t.TempDir()
			narsil := engineIn(t, directory)
			earlier := harbourIndex(t, narsil)
			earlierArchive := snapshotOf(t, narsil, callbackIndex)
			archived := make(map[string]string, len(earlier))
			for id, title := range earlier {
				archived[id] = title
			}
			removedBefore := layerArchivedIndex(t, narsil, archived)
			before := topLevelEntries(t, directory)
			inner := &callingWriter{act: func() error {
				if err := narsil.DropIndex(ctx, callbackIndex); err != nil {
					return err
				}
				return restoreArchive(narsil, callbackIndex, earlierArchive)
			}}
			outer := &callingWriter{act: func() error { return route.write(narsil, inner) }}
			if _, err := finishedWithin(t, name, func() (struct{}, error) { return struct{}{}, route.write(narsil, outer) }); err != nil {
				t.Fatalf("the %s failed with %s: %v", name, codeOrMessage(err), err)
			}
			if !inner.called || inner.err != nil || !outer.called || outer.err != nil {
				t.Fatalf("the inner writer called=%t returned %v; the outer writer called=%t returned %v",
					inner.called, inner.err, outer.called, outer.err)
			}
			if after := topLevelEntries(t, directory); !slices.Equal(after, before) {
				t.Fatalf("after the last archive released, the directory holds %v; before the %s it held %v", after, name, before)
			}
			reader := startedForCallbacks(t, false)
			if err := route.read(reader, archiveCopyIndex, inner.Bytes()); err != nil {
				t.Fatalf("reading the inner %s back failed with %s: %v", name, codeOrMessage(err), err)
			}
			if err := route.read(reader, outerArchiveCopyIndex, outer.Bytes()); err != nil {
				t.Fatalf("reading the outer %s back failed with %s: %v", name, codeOrMessage(err), err)
			}
			requireTitles(t, reader, archiveCopyIndex, archived, removedBefore)
			requireTitles(t, reader, outerArchiveCopyIndex, archived, removedBefore)
			requireTitles(t, narsil, callbackIndex, earlier, nil)
			shutDownWithin(t, narsil, "after the "+name)
			reopened := engineIn(t, directory)
			defer shutDownWithin(t, reopened, "after the reopen")
			if after := topLevelEntries(t, directory); !slices.Equal(after, before) {
				t.Fatalf("after the reopen, the directory holds %v; before the %s it held %v", after, name, before)
			}
			requireTitles(t, reopened, callbackIndex, earlier, nil)
		})
	}
}
