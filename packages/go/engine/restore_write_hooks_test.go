package engine_test

import (
	"context"
	"maps"
	"testing"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const hookedRebalanceTarget = 1

type hookedWrite struct {
	name  string
	write func(narsil *engine.Narsil) error
	apply func(notes titledNotes)
}

func identifiedNote(id string, title string) *engine.Document {
	return engine.DocumentFromMap(map[string]any{"id": id, "title": title})
}

func insertFresh(notes titledNotes) {
	notes[hookedFreshID] = hookedFreshTitle
}

func updateShared(notes titledNotes) {
	notes[hookedSharedID] = hookedUpdatedTitle
}

func removeShared(notes titledNotes) {
	delete(notes, hookedSharedID)
}

var hookedWrites = []hookedWrite{
	{name: "insert", apply: insertFresh, write: func(narsil *engine.Narsil) error {
		_, err := narsil.Insert(context.Background(), hookedIndex, noteDocument(hookedFreshTitle), hookedFreshID,
			engine.InsertOptions{})
		return err
	}},
	{name: "update", apply: updateShared, write: func(narsil *engine.Narsil) error {
		return narsil.Update(context.Background(), hookedIndex, hookedSharedID, noteDocument(hookedUpdatedTitle),
			engine.WriteOptions{})
	}},
	{name: "remove", apply: removeShared, write: func(narsil *engine.Narsil) error {
		return narsil.Remove(context.Background(), hookedIndex, hookedSharedID, engine.WriteOptions{})
	}},
	{name: "insert batch", apply: insertFresh, write: func(narsil *engine.Narsil) error {
		documents := []*engine.Document{identifiedNote(hookedFreshID, hookedFreshTitle)}
		return requireWholeBatch(narsil.InsertBatch(context.Background(), hookedIndex, documents, engine.InsertOptions{}))
	}},
	{name: "update batch", apply: updateShared, write: func(narsil *engine.Narsil) error {
		updates := []engine.DocumentUpdate{{DocID: hookedSharedID, Document: noteDocument(hookedUpdatedTitle)}}
		return requireWholeBatch(narsil.UpdateBatch(context.Background(), hookedIndex, updates, engine.WriteOptions{}))
	}},
	{name: "remove batch", apply: removeShared, write: func(narsil *engine.Narsil) error {
		ids := []string{hookedSharedID}
		return requireWholeBatch(narsil.RemoveBatch(context.Background(), hookedIndex, ids, engine.WriteOptions{}))
	}},
}

func writeHooksActing(once *actionOnce, beforeWrite bool) engine.Plugin {
	plugin := engine.Plugin{Name: "acting-on-writes"}
	if beforeWrite {
		plugin.BeforeInsert = func(context.Context, *engine.InsertContext) error { once.fire(); return nil }
		plugin.BeforeUpdate = func(context.Context, *engine.UpdateContext) error { once.fire(); return nil }
		plugin.BeforeRemove = func(context.Context, *engine.RemoveContext) error { once.fire(); return nil }
		return plugin
	}
	plugin.AfterInsert = func(context.Context, *engine.InsertContext) error { once.fire(); return nil }
	plugin.AfterUpdate = func(context.Context, *engine.UpdateContext) error { once.fire(); return nil }
	plugin.AfterRemove = func(context.Context, *engine.RemoveContext) error { once.fire(); return nil }
	return plugin
}

func applied(base titledNotes, write hookedWrite) titledNotes {
	notes := maps.Clone(base)
	write.apply(notes)
	return notes
}

func requireWriteOutcome(t *testing.T, narsil *engine.Narsil, write hookedWrite, action indexAction, beforeWrite bool,
	err error) {
	t.Helper()
	if action == dropFromHook && beforeWrite {
		if engine.ErrorCode(err) != engine.CodeIndexNotFound {
			t.Fatalf("the write returned %s, while the oracle expects %s", codeOrMessage(err), engine.CodeIndexNotFound)
		}
		requireIndexGone(t, narsil)
		return
	}
	if err != nil {
		t.Fatalf("the write failed with %s: %v", codeOrMessage(err), err)
	}
	switch {
	case action == dropFromHook:
		requireIndexGone(t, narsil)
	case action == closeFromHook:
		requireIndexHolds(t, narsil, applied(liveNotes(), write))
	case beforeWrite:
		requireIndexHolds(t, narsil, applied(archivedNotes(), write))
	default:
		requireIndexHolds(t, narsil, archivedNotes())
	}
}

func TestAWriteWhosePluginHookActsOnTheIndexFinishesOnTheIndexInPlace(t *testing.T) {
	archive := archiveOfNotes(t)
	for _, phase := range []string{"before", "after"} {
		beforeWrite := phase == "before"
		for _, write := range hookedWrites {
			for _, action := range everyIndexAction {
				t.Run(phase+" "+write.name+" "+string(action), func(t *testing.T) {
					once := &actionOnce{action: action, archive: archive}
					narsil := startedWithHooks(t, once, writeHooksActing(once, beforeWrite))
					writeNotes(t, narsil, liveNotes())
					once.armed.Store(true)
					_, err := finishedWithin(t, "a "+write.name+" whose "+phase+" hook runs a "+string(action),
						func() (struct{}, error) { return struct{}{}, write.write(narsil) })
					once.requireFired(t)
					requireWriteOutcome(t, narsil, write, action, beforeWrite, err)
				})
			}
		}
	}
}

func TestARebalanceWhoseSplitHookRestoresTheIndexLeavesTheRestoredIndex(t *testing.T) {
	once := &actionOnce{action: restoreFromHook, archive: archiveOfNotes(t)}
	plugin := engine.Plugin{Name: "restoring-on-split", OnPartitionSplit: func(context.Context, *engine.PartitionContext) error {
		once.fire()
		return nil
	}}
	narsil := startedWithHooks(t, once, plugin)
	writeNotes(t, narsil, liveNotes())
	once.armed.Store(true)
	_, err := finishedWithin(t, "a rebalance whose split hook restores", func() (struct{}, error) {
		return struct{}{}, narsil.Rebalance(context.Background(), hookedIndex, hookedRebalanceTarget)
	})
	once.requireFired(t)
	if err != nil {
		t.Fatalf("the rebalance failed with %s: %v", codeOrMessage(err), err)
	}
	requireIndexHolds(t, narsil, archivedNotes())
}

func TestAnIndexLifecycleHookThatRestoresItsIndexLeavesTheRestoredIndex(t *testing.T) {
	for _, hook := range []string{"create", "drop"} {
		t.Run(hook, func(t *testing.T) {
			once := &actionOnce{action: restoreFromHook, archive: archiveOfNotes(t)}
			restore := func(context.Context, *engine.IndexContext) error {
				once.fire()
				return nil
			}
			plugin := engine.Plugin{Name: "restoring-on-" + hook}
			if hook == "create" {
				plugin.OnIndexCreate = restore
			} else {
				plugin.OnIndexDrop = restore
			}
			narsil := startedWithHooks(t, once, plugin)
			if hook == "drop" {
				writeNotes(t, narsil, liveNotes())
			}
			once.armed.Store(true)
			_, err := finishedWithin(t, "an index "+hook+" whose hook restores", func() (struct{}, error) {
				if hook == "create" {
					return struct{}{}, narsil.CreateIndex(context.Background(), hookedIndex, hookedIndexConfig())
				}
				return struct{}{}, narsil.DropIndex(context.Background(), hookedIndex)
			})
			once.requireFired(t)
			if err != nil {
				t.Fatalf("the index %s failed with %s: %v", hook, codeOrMessage(err), err)
			}
			requireIndexHolds(t, narsil, archivedNotes())
		})
	}
}
