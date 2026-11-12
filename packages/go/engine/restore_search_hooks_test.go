package engine_test

import (
	"context"
	"maps"
	"sync/atomic"
	"testing"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	hookedIndex         = "notes"
	hookedSharedID      = "shared"
	hookedFreshID       = "fresh"
	hookedFreshTitle    = "fresh note"
	hookedUpdatedTitle  = "updated shared note"
	hookedSearchTerm    = "note"
	hookedSearchLimit   = 100
	hookedMaxPartitions = 2
)

type titledNotes map[string]string

func archivedNotes() titledNotes {
	return titledNotes{"archived-0": "archived note", "archived-1": "archived note", "archived-2": "archived note",
		hookedSharedID: "archived shared note"}
}

func liveNotes() titledNotes {
	return titledNotes{"live-0": "live note", "live-1": "live note", hookedSharedID: "live shared note"}
}

func hookedIndexConfig() engine.IndexConfig {
	return engine.IndexConfig{Schema: engine.Schema{"title": engine.FieldString},
		Partitions: engine.PartitionConfig{MaxPartitions: engine.Some(hookedMaxPartitions)}}
}

func noteDocument(title string) *engine.Document {
	return engine.DocumentFromMap(map[string]any{"title": title})
}

func writeNotes(t *testing.T, narsil *engine.Narsil, notes titledNotes) {
	t.Helper()
	if err := narsil.CreateIndex(context.Background(), hookedIndex, hookedIndexConfig()); err != nil {
		t.Fatalf("the engine refused the index with %s: %v", codeOrMessage(err), err)
	}
	for id, title := range notes {
		if _, err := narsil.Insert(context.Background(), hookedIndex, noteDocument(title), id, engine.InsertOptions{}); err != nil {
			t.Fatalf("the engine refused %s with %s: %v", id, codeOrMessage(err), err)
		}
	}
}

func archiveOfNotes(t *testing.T) []byte {
	t.Helper()
	source := startedForCallbacks(t, false)
	writeNotes(t, source, archivedNotes())
	return snapshotOf(t, source, hookedIndex)
}

type indexAction string

const (
	restoreFromHook indexAction = "restore"
	dropFromHook    indexAction = "drop"
	closeFromHook   indexAction = "close"
)

var everyIndexAction = []indexAction{restoreFromHook, dropFromHook, closeFromHook}

type actionOnce struct {
	narsil  *engine.Narsil
	action  indexAction
	archive []byte
	armed   atomic.Bool
	fired   atomic.Bool
	err     error
}

func (once *actionOnce) fire() {
	if !once.armed.Load() || once.fired.Swap(true) {
		return
	}
	ctx := context.Background()
	switch once.action {
	case restoreFromHook:
		once.err = restoreArchive(once.narsil, hookedIndex, once.archive)
	case dropFromHook:
		once.err = once.narsil.DropIndex(ctx, hookedIndex)
	case closeFromHook:
		once.err = once.narsil.Close(ctx, hookedIndex)
	}
}

func (once *actionOnce) requireFired(t *testing.T) {
	t.Helper()
	once.armed.Store(false)
	if !once.fired.Load() {
		t.Fatalf("the hook never ran its %s", once.action)
	}
	if once.err != nil {
		t.Fatalf("the %s from the hook failed with %s: %v", once.action, codeOrMessage(once.err), once.err)
	}
}

func startedWithHooks(t *testing.T, once *actionOnce, plugin engine.Plugin) *engine.Narsil {
	t.Helper()
	config := engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)}, Plugins: []engine.Plugin{plugin},
		Durability: &engine.DurabilityConfig{Directory: t.TempDir(), Mode: engine.DurabilitySync}}
	narsil, err := engine.New(context.Background(), config)
	if err != nil {
		t.Fatalf("the engine refused to start with %s: %v", codeOrMessage(err), err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), callbackShutdownWait)
		defer cancel()
		_ = narsil.Shutdown(ctx)
	})
	once.narsil = narsil
	return narsil
}

func noteSearch() engine.QueryParams {
	return engine.QueryParams{Term: hookedSearchTerm, Limit: engine.Some(hookedSearchLimit)}
}

func notesOf(t *testing.T, result engine.QueryResult) titledNotes {
	t.Helper()
	notes := titledNotes{}
	for _, hit := range result.Hits {
		title, _ := hit.Document.Get("title")
		text, isText := title.(string)
		if !isText {
			t.Fatalf("hit %s carries the title %v, which is not a string", hit.ID, title)
		}
		notes[hit.ID] = text
	}
	return notes
}

func requireNotes(t *testing.T, label string, found titledNotes, wanted titledNotes) {
	t.Helper()
	if !maps.Equal(found, wanted) {
		t.Fatalf("%s holds %v, while the oracle expects %v", label, found, wanted)
	}
}

func requireIndexHolds(t *testing.T, narsil *engine.Narsil, wanted titledNotes) {
	t.Helper()
	result, err := narsil.Query(context.Background(), hookedIndex, noteSearch())
	if err != nil {
		t.Fatalf("the query after the hook failed with %s: %v", codeOrMessage(err), err)
	}
	requireNotes(t, "the index after the hook", notesOf(t, result), wanted)
}

func requireIndexGone(t *testing.T, narsil *engine.Narsil) {
	t.Helper()
	_, err := narsil.Query(context.Background(), hookedIndex, noteSearch())
	if engine.ErrorCode(err) != engine.CodeIndexNotFound {
		t.Fatalf("a query on the dropped index returned %s, while the oracle expects %s",
			codeOrMessage(err), engine.CodeIndexNotFound)
	}
}

func searchHookEngine(t *testing.T, action indexAction, beforeSearch bool) (*engine.Narsil, *actionOnce) {
	t.Helper()
	once := &actionOnce{action: action, archive: archiveOfNotes(t)}
	hook := func(context.Context, *engine.SearchContext) error {
		once.fire()
		return nil
	}
	plugin := engine.Plugin{Name: "acting-on-search"}
	if beforeSearch {
		plugin.BeforeSearch = hook
	} else {
		plugin.AfterSearch = hook
	}
	narsil := startedWithHooks(t, once, plugin)
	writeNotes(t, narsil, liveNotes())
	once.armed.Store(true)
	return narsil, once
}

func TestAQueryWhoseBeforeSearchHookActsOnTheIndexAnswersFromTheIndexInPlace(t *testing.T) {
	for _, action := range everyIndexAction {
		t.Run(string(action), func(t *testing.T) {
			narsil, once := searchHookEngine(t, action, true)
			result, err := finishedWithin(t, "a query whose beforeSearch hook runs a "+string(action), func() (engine.QueryResult, error) {
				return narsil.Query(context.Background(), hookedIndex, noteSearch())
			})
			once.requireFired(t)
			switch action {
			case restoreFromHook:
				if err != nil {
					t.Fatalf("the query failed with %s: %v", codeOrMessage(err), err)
				}
				requireNotes(t, "the query result", notesOf(t, result), archivedNotes())
			case dropFromHook:
				if engine.ErrorCode(err) != engine.CodeIndexNotFound {
					t.Fatalf("the query returned %s, while the oracle expects %s", codeOrMessage(err), engine.CodeIndexNotFound)
				}
			case closeFromHook:
				if err != nil {
					t.Fatalf("the query failed with %s: %v", codeOrMessage(err), err)
				}
				requireNotes(t, "the query result", notesOf(t, result), liveNotes())
			}
		})
	}
}

func TestAPreflightWhoseBeforeSearchHookRestoresTheIndexCountsTheRestoredIndex(t *testing.T) {
	narsil, once := searchHookEngine(t, restoreFromHook, true)
	result, err := finishedWithin(t, "a preflight whose beforeSearch hook restores", func() (engine.PreflightResult, error) {
		return narsil.Preflight(context.Background(), hookedIndex, noteSearch())
	})
	once.requireFired(t)
	if err != nil {
		t.Fatalf("the preflight failed with %s: %v", codeOrMessage(err), err)
	}
	if result.Count != len(archivedNotes()) {
		t.Fatalf("the preflight counted %d documents, while the oracle expects %d", result.Count, len(archivedNotes()))
	}
}

func TestAQueryWhoseAfterSearchHookActsOnTheIndexReturnsTheAnswerItRanFor(t *testing.T) {
	for _, action := range everyIndexAction {
		t.Run(string(action), func(t *testing.T) {
			narsil, once := searchHookEngine(t, action, false)
			result, err := finishedWithin(t, "a query whose afterSearch hook runs a "+string(action), func() (engine.QueryResult, error) {
				return narsil.Query(context.Background(), hookedIndex, noteSearch())
			})
			once.requireFired(t)
			if err != nil {
				t.Fatalf("the query failed with %s: %v", codeOrMessage(err), err)
			}
			requireNotes(t, "the query result", notesOf(t, result), liveNotes())
			switch action {
			case restoreFromHook:
				requireIndexHolds(t, narsil, archivedNotes())
			case dropFromHook:
				requireIndexGone(t, narsil)
			case closeFromHook:
				requireIndexHolds(t, narsil, liveNotes())
			}
		})
	}
}
