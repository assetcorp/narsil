package engine_test

import (
	"context"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	asyncFlushTicket          = "ticket-after-subscription"
	asyncFlushDefaultInterval = time.Second
	asyncFlushQuietPeriod     = 3 * asyncFlushDefaultInterval
)

func openAsyncChangesEngine(t *testing.T, flushInterval engine.Optional[time.Duration]) *engine.Narsil {
	t.Helper()
	durability := &engine.DurabilityConfig{Directory: t.TempDir(), Mode: engine.DurabilityAsync,
		FlushInterval: flushInterval}
	narsil := openSavedSizeEngine(t, engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)},
		Durability: durability})
	createChangesIndex(t, narsil, 1, engine.ChangesSetting{Enabled: true})
	return narsil
}

func insertAfterSubscribing(t *testing.T, narsil *engine.Narsil) *changesTap {
	t.Helper()
	tap := tapChanges(t, narsil, engine.ChangesRequest{})
	tap.subscribed(t)
	if _, err := narsil.Insert(context.Background(), changesIndex,
		engine.DocumentFromMap(ticket(asyncFlushTicket, 1, "open")), asyncFlushTicket, engine.InsertOptions{}); err != nil {
		t.Fatalf("the insert failed with %s: %v", codeOrMessage(err), err)
	}
	return tap
}

func requireTicketDelivered(t *testing.T, tap *changesTap, after string) {
	t.Helper()
	for {
		received := tap.next(t)
		if received.err != nil {
			t.Fatalf("%s, the changes failed with %s: %v", after, codeOrMessage(received.err), received.err)
		}
		if received.event.Group == nil {
			continue
		}
		for _, change := range received.event.Group.Changes {
			if change.DocumentID == asyncFlushTicket {
				return
			}
		}
	}
}

func TestAsyncFlushIntervalUnsetFlushesEverySecondAndZeroLeavesFlushingToCheckpoints(t *testing.T) {
	t.Run("an unset interval flushes the log on the default timer", func(t *testing.T) {
		narsil := openAsyncChangesEngine(t, engine.Optional[time.Duration]{})
		tap := insertAfterSubscribing(t, narsil)
		requireTicketDelivered(t, tap, "with an unset flush interval")
	})

	t.Run("an interval of 0 holds the log back until a checkpoint", func(t *testing.T) {
		narsil := openAsyncChangesEngine(t, engine.Some(time.Duration(0)))
		tap := insertAfterSubscribing(t, narsil)
		select {
		case received := <-tap.events:
			t.Fatalf("with the flush timer off, the changes delivered %+v, error %v, before any checkpoint",
				received.event, received.err)
		case <-time.After(asyncFlushQuietPeriod):
		}
		if err := narsil.Checkpoint(context.Background(), changesIndex); err != nil {
			t.Fatalf("the checkpoint failed with %s: %v", codeOrMessage(err), err)
		}
		requireTicketDelivered(t, tap, "after the checkpoint")
	})
}
