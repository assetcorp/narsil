package engine_test

import (
	"bytes"
	"context"
	"errors"
	"io/fs"
	"path/filepath"
	"testing"

	"github.com/assetcorp/narsil/packages/go/engine"
)

func openFollowedIndex(t *testing.T, setting engine.ChangesSetting) (*engine.Narsil, *changesTap, *subscriber,
	*writeOracle) {
	t.Helper()
	narsil := openChangesEngine(t, t.TempDir(), 0)
	t.Cleanup(func() { _ = narsil.Shutdown(context.Background()) })
	createChangesIndex(t, narsil, 2, setting)
	oracle := newWriteOracle()
	oracle.insert(t, narsil, "a", ticket("a", 0, "open"))
	tap := tapChanges(t, narsil, engine.ChangesRequest{})
	reader := newSubscriber(tap.subscribed(t))
	return narsil, tap, reader, oracle
}

func requireNewEpoch(t *testing.T, narsil *engine.Narsil, previous string) string {
	t.Helper()
	status, err := narsil.GetChanges(context.Background(), changesIndex)
	if err != nil || !status.Enabled || status.Epoch == previous || len(status.Epoch) != 32 {
		t.Fatalf("the index reads %+v with error %s, while it needed a new epoch after %s", status, codeOrMessage(err),
			previous)
	}
	return status.Epoch
}

func TestChangesEndWithAnEpochResyncWhenTheIndexRenewsItsEpoch(t *testing.T) {
	setting := engine.ChangesSetting{Enabled: true, PreviousDocument: true}
	ctx := context.Background()
	renewals := map[string]func(t *testing.T, narsil *engine.Narsil){
		"clear": func(t *testing.T, narsil *engine.Narsil) {
			if err := narsil.Clear(ctx, changesIndex); err != nil {
				t.Fatalf("the clear failed with %s: %v", codeOrMessage(err), err)
			}
		},
		"rebalance": func(t *testing.T, narsil *engine.Narsil) {
			if err := narsil.Rebalance(ctx, changesIndex, 3); err != nil {
				t.Fatalf("the rebalance failed with %s: %v", codeOrMessage(err), err)
			}
		},
		"restore": func(t *testing.T, narsil *engine.Narsil) {
			var archive bytes.Buffer
			if err := narsil.Snapshot(ctx, changesIndex, engine.SnapshotOptions{}, &archive); err != nil {
				t.Fatalf("the snapshot failed with %s: %v", codeOrMessage(err), err)
			}
			if err := narsil.Restore(ctx, changesIndex, &archive); err != nil {
				t.Fatalf("the restore failed with %s: %v", codeOrMessage(err), err)
			}
		},
	}
	for name, renew := range renewals {
		t.Run(name, func(t *testing.T) {
			narsil, tap, reader, oracle := openFollowedIndex(t, setting)
			oracle.update(t, narsil, "a", ticket("a", 1, "closed"))
			renew(t, narsil)
			if reason := tap.resync(t); reason != engine.ResyncEpoch {
				t.Fatalf("the open iteration ended with a resync for %q", reason)
			}
			epoch := requireNewEpoch(t, narsil, reader.epoch)
			stale := tapChanges(t, narsil, reader.request())
			if reason := stale.resync(t); reason != engine.ResyncEpoch {
				t.Fatalf("a request under the old epoch ended with a resync for %q", reason)
			}
			status, err := narsil.GetChanges(ctx, changesIndex)
			if err != nil || !status.PreviousDocument || status.Epoch != epoch {
				t.Fatalf("the renewal changed the setting to %+v with error %s", status, codeOrMessage(err))
			}
			oracle.forget()
			fresh := tapChanges(t, narsil, engine.ChangesRequest{})
			following := newSubscriber(fresh.subscribed(t))
			if following.epoch != epoch {
				t.Fatalf("a new subscription reports epoch %s, while the index holds %s", following.epoch, epoch)
			}
			oracle.insert(t, narsil, "b", ticket("b", 0, "open"))
			following.documents = oracle.snapshot()
			delete(following.documents, "b")
			following.catchUp(t, fresh, oracle)
		})
	}
}

func TestChangesFailWhenCaptureOrThePreviousDocumentTurnsOffUnderThem(t *testing.T) {
	ctx := context.Background()
	t.Run("capture off", func(t *testing.T) {
		narsil, tap, _, _ := openFollowedIndex(t, engine.ChangesSetting{Enabled: true})
		if err := narsil.UpdateChanges(ctx, changesIndex, engine.ChangesSetting{Enabled: false}); err != nil {
			t.Fatalf("turning capture off failed with %s: %v", codeOrMessage(err), err)
		}
		if failure := tap.failure(t); engine.ErrorCode(failure) != engine.CodeChangesNotEnabled {
			t.Fatalf("the open iteration failed with %s after capture turned off", codeOrMessage(failure))
		}
		status, err := narsil.GetChanges(ctx, changesIndex)
		if err != nil || status.Enabled || status.Epoch != "" {
			t.Fatalf("after turning capture off the index reads %+v with error %s", status, codeOrMessage(err))
		}
		closed := tapChanges(t, narsil, engine.ChangesRequest{})
		if failure := closed.failure(t); engine.ErrorCode(failure) != engine.CodeChangesNotEnabled {
			t.Fatalf("a request on an index without capture failed with %s", codeOrMessage(failure))
		}
	})
	t.Run("previous document off under a filter", func(t *testing.T) {
		narsil, _, reader, _ := openFollowedIndex(t, engine.ChangesSetting{Enabled: true, PreviousDocument: true})
		request := reader.request()
		request.Filter = &engine.FilterExpression{Fields: map[string]engine.FieldFilter{"status": {Eq: engine.TextValue("open")}}}
		filtered := tapChanges(t, narsil, request)
		filtered.subscribed(t)
		if err := narsil.UpdateChanges(ctx, changesIndex, engine.ChangesSetting{Enabled: true}); err != nil {
			t.Fatalf("turning previousDocument off failed with %s: %v", codeOrMessage(err), err)
		}
		if failure := filtered.failure(t); engine.ErrorCode(failure) != engine.CodeChangesPreviousDocumentRequired {
			t.Fatalf("the filtered iteration failed with %s after previousDocument turned off", codeOrMessage(failure))
		}
		status, err := narsil.GetChanges(ctx, changesIndex)
		if err != nil || status.Epoch != reader.epoch {
			t.Fatalf("turning previousDocument off changed the epoch to %+v with error %s", status, codeOrMessage(err))
		}
	})
}

func historyFiles(t *testing.T, directory string) []string {
	t.Helper()
	var files []string
	root := filepath.Join(directory, changesIndex, "history")
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.IsDir() {
			files = append(files, path)
		}
		return nil
	})
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("listing the history failed: %v", err)
	}
	return files
}

func TestTurningCaptureOffDeletesTheHistoryThatHoldsRemovedDocuments(t *testing.T) {
	directory := t.TempDir()
	narsil := openChangesEngine(t, directory, historySegmentBytes)
	defer func() { _ = narsil.Shutdown(context.Background()) }()
	ctx := context.Background()
	createChangesIndex(t, narsil, 1, engine.ChangesSetting{Enabled: true, PreviousDocument: true})
	oracle := newWriteOracle()
	writeTicketRound(t, narsil, oracle, 0)
	for id := range oracle.snapshot() {
		oracle.remove(t, narsil, id)
	}
	if err := narsil.Checkpoint(ctx, changesIndex); err != nil {
		t.Fatalf("the checkpoint failed with %s: %v", codeOrMessage(err), err)
	}
	if len(historyFiles(t, directory)) == 0 {
		t.Fatal("a checkpoint with change capture on kept no history")
	}
	if err := narsil.UpdateChanges(ctx, changesIndex, engine.ChangesSetting{Enabled: false}); err != nil {
		t.Fatalf("turning capture off failed with %s: %v", codeOrMessage(err), err)
	}
	if kept := historyFiles(t, directory); len(kept) != 0 {
		t.Fatalf("turning capture off left %d history files that hold removed documents", len(kept))
	}
	if err := narsil.Shutdown(ctx); err != nil {
		t.Fatalf("the shutdown failed with %s: %v", codeOrMessage(err), err)
	}
	reopened := openChangesEngine(t, directory, historySegmentBytes)
	defer func() { _ = reopened.Shutdown(context.Background()) }()
	status, err := reopened.GetChanges(ctx, changesIndex)
	if err != nil || status.Enabled {
		t.Fatalf("after the restart capture reads %+v with error %s", status, codeOrMessage(err))
	}
}

func TestChangeCaptureAndDeviceSyncShareOneEpoch(t *testing.T) {
	narsil := openChangesEngine(t, t.TempDir(), 0)
	defer func() { _ = narsil.Shutdown(context.Background()) }()
	ctx := context.Background()
	createChangesIndex(t, narsil, 1, engine.ChangesSetting{Enabled: true})
	capture, err := narsil.GetChanges(ctx, changesIndex)
	if err != nil {
		t.Fatalf("reading the setting failed with %s: %v", codeOrMessage(err), err)
	}
	if err := narsil.UpdateSync(ctx, changesIndex, engine.SyncSetting{Enabled: true}); err != nil {
		t.Fatalf("turning sync on failed with %s: %v", codeOrMessage(err), err)
	}
	synced, err := narsil.GetSync(ctx, changesIndex)
	if err != nil || synced.Epoch != capture.Epoch {
		t.Fatalf("turning sync on while capture is on gave epoch %q with error %s, while capture holds %q",
			synced.Epoch, codeOrMessage(err), capture.Epoch)
	}
	if err := narsil.UpdateChanges(ctx, changesIndex, engine.ChangesSetting{Enabled: false}); err != nil {
		t.Fatalf("turning capture off failed with %s: %v", codeOrMessage(err), err)
	}
	if err := narsil.UpdateChanges(ctx, changesIndex, engine.ChangesSetting{Enabled: true}); err != nil {
		t.Fatalf("turning capture on again failed with %s: %v", codeOrMessage(err), err)
	}
	again, err := narsil.GetChanges(ctx, changesIndex)
	if err != nil || again.Epoch != capture.Epoch {
		t.Fatalf("turning capture on while sync is on gave epoch %q, while sync holds %q", again.Epoch, capture.Epoch)
	}
	if err := narsil.UpdateSync(ctx, changesIndex, engine.SyncSetting{Enabled: false}); err != nil {
		t.Fatalf("turning sync off failed with %s: %v", codeOrMessage(err), err)
	}
	kept, err := narsil.GetChanges(ctx, changesIndex)
	if err != nil || !kept.Enabled || kept.Epoch != capture.Epoch {
		t.Fatalf("turning sync off left capture at %+v with error %s", kept, codeOrMessage(err))
	}
	if err := narsil.UpdateChanges(ctx, changesIndex, engine.ChangesSetting{Enabled: false}); err != nil {
		t.Fatalf("turning capture off failed with %s: %v", codeOrMessage(err), err)
	}
	if err := narsil.UpdateChanges(ctx, changesIndex, engine.ChangesSetting{Enabled: true}); err != nil {
		t.Fatalf("turning capture on failed with %s: %v", codeOrMessage(err), err)
	}
	requireNewEpoch(t, narsil, capture.Epoch)
}
