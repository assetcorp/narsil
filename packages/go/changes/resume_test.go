package changes_test

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	narsil "github.com/assetcorp/narsil/packages/go"
	"github.com/assetcorp/narsil/packages/go/changes"
)

const (
	smallWindowBytes = 4_096
	quietPeriod      = 500 * time.Millisecond
	feedWaitTimeout  = 30 * time.Second
	readerLifetimeMs = 400
)

type received struct {
	event changes.Event
	err   error
}

func pump(t *testing.T, subscription *changes.Subscription) <-chan received {
	events := make(chan received)
	finished := t.Context().Done()
	go func() {
		defer close(events)
		for {
			event, err := subscription.Next()
			select {
			case events <- received{event: event, err: err}:
			case <-finished:
				return
			}
			if err != nil {
				return
			}
		}
	}()
	return events
}

func nextEvent(t *testing.T, events <-chan received, wait time.Duration) (changes.Event, bool) {
	t.Helper()
	select {
	case next, open := <-events:
		if !open {
			t.Fatal("the feed ended")
		}
		if next.err != nil {
			t.Fatal(next.err)
		}
		return next.event, true
	case <-time.After(wait):
		return nil, false
	}
}

func subscribedOf(t *testing.T, events <-chan received) *changes.Subscribed {
	t.Helper()
	event, ok := nextEvent(t, events, feedWaitTimeout)
	subscribed, isSubscribed := event.(*changes.Subscribed)
	if !ok || !isSubscribed {
		t.Fatalf("the feed opened with %#v", event)
	}
	return subscribed
}

func insertMany(t *testing.T, ctx context.Context, admin *narsil.Client, prefix string, count int) {
	t.Helper()
	for at := range count {
		insert(t, ctx, admin, fmt.Sprintf("%s%d", prefix, at), product(at))
	}
}

func TestResumingFromSavedPositionsLosesAndRepeatsNothing(t *testing.T) {
	ctx := testContext(t)
	server := startServer(t, serverSettings{WindowBytes: smallWindowBytes})
	admin := newClient(t, server, adminCredential)
	shopWithCapture(t, ctx, admin, false)
	reader := newClient(t, server, "")

	firstCtx, disconnect := context.WithCancel(ctx)
	first := follow(t, firstCtx, reader, changes.Options{Credential: readerCredential})
	firstEvents := pump(t, first)
	opened := subscribedOf(t, firstEvents)
	const written = 200
	insertMany(t, ctx, admin, "w", written)

	applied := map[string]int{}
	saved := map[uint32]uint64{}
	for _, position := range opened.Positions {
		saved[position.PartitionID] = position.SeqNo
	}
	for range 3 {
		event, ok := nextEvent(t, firstEvents, feedWaitTimeout)
		batch, isBatch := event.(*changes.Batch)
		if !ok || !isBatch {
			t.Fatalf("the feed sent %#v in place of changes", event)
		}
		for _, change := range batch.Changes {
			applied[change.DocumentID]++
		}
		saved[batch.PartitionID] = batch.ScannedSeqNo
		if err := first.Ack([]changes.Position{{PartitionID: batch.PartitionID, SeqNo: batch.ScannedSeqNo}}); err != nil {
			t.Fatal(err)
		}
	}
	disconnect()
	for next := range firstEvents {
		if next.err != nil {
			requireCode(t, next.err, narsil.CodeClientRequestAborted)
		}
	}
	if len(applied) >= written {
		t.Fatalf("the window let the first subscriber take all %d changes before it disconnected", written)
	}
	insertMany(t, ctx, admin, "x", 20)

	positions := make([]changes.Position, 0, len(saved))
	for partitionID := range uint32(opened.PartitionCount) {
		positions = append(positions, changes.Position{PartitionID: partitionID, SeqNo: saved[partitionID]})
	}
	secondCtx, cancelSecond := context.WithTimeout(ctx, feedWaitTimeout)
	defer cancelSecond()
	second := follow(t, secondCtx, reader, changes.Options{Epoch: opened.Epoch, Positions: positions, Credential: readerCredential})
	for event, err := range second.All() {
		if err != nil {
			t.Fatal(err)
		}
		switch typed := event.(type) {
		case *changes.Subscribed:
			for at, position := range typed.Positions {
				if position != positions[at] {
					t.Fatalf("the feed resumed from %+v, and the subscriber saved %+v", typed.Positions, positions)
				}
			}
		case *changes.Batch:
			for _, change := range typed.Changes {
				applied[change.DocumentID]++
			}
			if err := second.Ack([]changes.Position{{PartitionID: typed.PartitionID, SeqNo: typed.ScannedSeqNo}}); err != nil {
				t.Fatal(err)
			}
		}
		if len(applied) == written+20 {
			break
		}
	}
	for at := range written {
		requireAppliedOnce(t, applied, fmt.Sprintf("w%d", at))
	}
	for at := range 20 {
		requireAppliedOnce(t, applied, fmt.Sprintf("x%d", at))
	}
}

func requireAppliedOnce(t *testing.T, applied map[string]int, id string) {
	t.Helper()
	if applied[id] != 1 {
		t.Fatalf("the subscriber applied the change of %s %d times", id, applied[id])
	}
}

func TestTheWindowHoldsBackASubscriberUntilItAcknowledges(t *testing.T) {
	ctx := testContext(t)
	server := startServer(t, serverSettings{WindowBytes: smallWindowBytes})
	admin := newClient(t, server, adminCredential)
	shopWithCapture(t, ctx, admin, false)
	subscription := follow(t, ctx, newClient(t, server, ""), changes.Options{Credential: readerCredential})
	events := pump(t, subscription)
	opened := subscribedOf(t, events)
	if opened.WindowBytes != smallWindowBytes {
		t.Fatalf("the feed reported a window of %d bytes", opened.WindowBytes)
	}
	const written = 200
	insertMany(t, ctx, admin, "w", written)

	seen := map[string]int{}
	var unacknowledged []changes.Position
	collect := func(wait time.Duration) bool {
		event, ok := nextEvent(t, events, wait)
		if batch, isBatch := event.(*changes.Batch); ok && isBatch {
			for _, change := range batch.Changes {
				seen[change.DocumentID]++
			}
			unacknowledged = append(unacknowledged, changes.Position{PartitionID: batch.PartitionID, SeqNo: batch.ScannedSeqNo})
		}
		return ok
	}
	if !collect(feedWaitTimeout) {
		t.Fatal("the feed sent no changes")
	}
	for collect(quietPeriod) {
	}
	if len(seen) >= written {
		t.Fatalf("the feed sent all %d changes to a subscriber that acknowledged none", written)
	}

	deadline := time.Now().Add(feedWaitTimeout)
	for len(seen) < written {
		if time.Now().After(deadline) {
			t.Fatalf("the subscriber received %d of %d changes after acknowledging", len(seen), written)
		}
		if err := subscription.Ack(unacknowledged); err != nil {
			t.Fatal(err)
		}
		unacknowledged = nil
		for collect(quietPeriod) {
		}
	}
	for id, count := range seen {
		if count != 1 {
			t.Fatalf("the feed sent the change of %s %d times", id, count)
		}
	}
}

func TestARefusedOrExpiredCredentialEndsTheSubscriptionWithTheRightError(t *testing.T) {
	ctx := testContext(t)
	server := startServer(t, serverSettings{ReaderLifetimeMs: readerLifetimeMs})
	admin := newClient(t, server, adminCredential)
	shopWithCapture(t, ctx, admin, false)
	reader := newClient(t, server, "")

	_, err := changes.Follow(ctx, reader, testIndex, changes.Options{Credential: outsiderCredential})
	refused := requireCode(t, err, "FORBIDDEN")
	if refused.Status != 403 || strings.Contains(err.Error(), outsiderCredential) {
		t.Fatalf("the refusal came back as HTTP %d with %q", refused.Status, err.Error())
	}

	subscription := follow(t, ctx, reader, changes.Options{Credential: readerCredential})
	if _, err := subscription.Next(); err != nil {
		t.Fatal(err)
	}
	_, err = subscription.Next()
	requireCode(t, err, narsil.CodeClientConnectionFailed)
	if changes.CloseCode(err) != changes.CloseCredentialExpired || strings.Contains(fmt.Sprintf("%+v", err), readerCredential) {
		t.Fatalf("the expiry came back as close code %d with %q", changes.CloseCode(err), err.Error())
	}
	if _, again := subscription.Next(); again != err {
		t.Fatalf("a second Next returned %v after %v", again, err)
	}
}
