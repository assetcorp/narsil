package changes_test

import (
	"errors"
	"io"
	"slices"
	"testing"
	"time"

	narsil "github.com/assetcorp/narsil/packages/go"
	"github.com/assetcorp/narsil/packages/go/changes"
)

var (
	photoBytes = []byte{1, 2, 3, 4, 5, 6, 7, 8}
	addedAt    = time.Date(2026, time.March, 1, 12, 30, 45, 123_000_000, time.UTC)
)

func TestAChangeReturnsAVectorOnlyAtAVectorFieldPath(t *testing.T) {
	ctx := testContext(t)
	server := startServer(t, serverSettings{})
	admin := newClient(t, server, adminCredential)
	shopWithCapture(t, ctx, admin, false)

	reader := newClient(t, server, "")
	events := pump(t, follow(t, ctx, reader, changes.Options{Credential: readerCredential}))
	subscribed := subscribedOf(t, events)
	if !slices.Equal(subscribed.VectorFields, []string{"embedding"}) {
		t.Fatalf("the feed named the vector fields %v", subscribed.VectorFields)
	}

	photo := make([]any, len(photoBytes))
	for at, value := range photoBytes {
		photo[at] = value
	}
	server.insertTypedThroughEngine(t, "lamp", narsil.AnyDocument{
		"title": "lamp", "price": 12.0, "embedding": []any{0.5, -2.0, 4.0},
		"photo": photo, "addedAt": addedAt.Format(time.RFC3339Nano),
	}, engineFields{bytes: []string{"photo"}, dates: []string{"addedAt"}})

	var document narsil.AnyDocument
	for document == nil {
		event, ok := nextEvent(t, events, feedWaitTimeout)
		if !ok {
			t.Fatal("the feed sent no change within the wait")
		}
		if batch, isBatch := event.(*changes.Batch); isBatch && len(batch.Changes) > 0 {
			document = batch.Changes[0].Document
		}
	}
	if embedding, ok := document["embedding"].([]float32); !ok || !slices.Equal(embedding, []float32{0.5, -2, 4}) {
		t.Fatalf("the change holds the embedding %#v", document["embedding"])
	}
	if stored, ok := document["photo"].([]byte); !ok || !slices.Equal(stored, photoBytes) {
		t.Fatalf("the change holds the photo %#v", document["photo"])
	}
	if stored, ok := document["addedAt"].(time.Time); !ok || !stored.Equal(addedAt) {
		t.Fatalf("the change holds the date %#v", document["addedAt"])
	}
}

func TestAResyncInPlaceOfSubscribedEndsTheSubscription(t *testing.T) {
	ctx := testContext(t)
	server := startServer(t, serverSettings{})
	admin := newClient(t, server, adminCredential)
	shopWithCapture(t, ctx, admin, false)

	positions := make([]changes.Position, partitionCount)
	for at := range positions {
		positions[at] = changes.Position{PartitionID: uint32(at)}
	}
	reader := newClient(t, server, "")
	subscription := follow(t, ctx, reader, changes.Options{
		Epoch: "ffffffffffffffffffffffffffffffff", Positions: positions, Credential: readerCredential,
	})
	event, err := subscription.Next()
	if err != nil {
		t.Fatal(err)
	}
	if resync, ok := event.(*changes.Resync); !ok || resync.Reason != "epoch" {
		t.Fatalf("the feed opened with %#v", event)
	}
	if _, err := subscription.Next(); !errors.Is(err, io.EOF) {
		t.Fatalf("the subscription went on after the resync with %v", err)
	}
}
