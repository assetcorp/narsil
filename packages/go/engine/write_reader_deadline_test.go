package engine_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	readerHeldWriteDeadline = 25 * time.Millisecond
	readerHeldWriteGrace    = time.Second
	firstReaderHeldIDs      = 1 << 17
	readerHeldTries         = 4
	maxReaderHeldIDs        = firstReaderHeldIDs << (readerHeldTries - 1)
	maxWritesBesideARead    = 10_000
	readerHeldSeedTitle     = "harbour"
)

type writeBesideRead func(t *testing.T, narsil *engine.Narsil, attempt int, expected *string) error

func TestAWriteDeadlineEndsTheWaitForAnEarlierReader(t *testing.T) {
	t.Run("update", func(t *testing.T) { requireDeadlineBesideReads(t, updateBesideRead) })
	t.Run("clear", func(t *testing.T) { requireDeadlineBesideReads(t, clearBesideRead) })
}

func requireDeadlineBesideReads(t *testing.T, write writeBesideRead) {
	t.Helper()
	ctx := context.Background()
	narsil := startedForCallbacks(t, false)
	if err := narsil.CreateIndex(ctx, callbackIndex, engine.IndexConfig{
		Schema: engine.Schema{"title": engine.FieldString, "embedding": engine.VectorFieldType(2)},
	}); err != nil {
		t.Fatal(err)
	}
	insertReaderHeldSeed(t, narsil)
	expected := readerHeldSeedTitle
	for try := range readerHeldTries {
		if expiredBesideAReadOf(t, narsil, firstReaderHeldIDs<<try, write, &expected) {
			requireOnlyTitle(t, narsil, expected)
			return
		}
	}
	t.Fatalf("after %d reads of up to %d documents, no write ended at its deadline beside a read, so either writes "+
		"wait out readers past their deadline or this runner never overlapped a read", readerHeldTries, maxReaderHeldIDs)
}

func insertReaderHeldSeed(t *testing.T, narsil *engine.Narsil) {
	t.Helper()
	if _, err := narsil.Insert(context.Background(), callbackIndex,
		engine.NewDocument().Set("title", readerHeldSeedTitle), "kept", engine.InsertOptions{}); err != nil {
		t.Fatal(err)
	}
}

func expiredBesideAReadOf(t *testing.T, narsil *engine.Narsil, count int, write writeBesideRead, expected *string) bool {
	t.Helper()
	ids := make([]string, count)
	for at := range ids {
		ids[at] = "kept"
	}
	reading, cancelRead := context.WithCancel(context.Background())
	defer cancelRead()
	read := make(chan error, 1)
	go func() {
		_, err := narsil.GetMultiple(reading, callbackIndex, ids)
		read <- err
	}()
	for attempt := range maxWritesBesideARead {
		select {
		case err := <-read:
			if err != nil {
				t.Fatalf("the read of %d documents failed: %v", count, err)
			}
			return false
		default:
		}
		if err := write(t, narsil, attempt, expected); err == nil {
			continue
		}
		cancelRead()
		if err := <-read; err != nil && !errors.Is(err, context.Canceled) {
			t.Fatalf("the read of %d documents failed once cancelled: %v", count, err)
		}
		return true
	}
	cancelRead()
	<-read
	t.Fatalf("%d writes committed beside one read of %d documents and none ended at its deadline",
		maxWritesBesideARead, count)
	return false
}

func updateBesideRead(t *testing.T, narsil *engine.Narsil, attempt int, expected *string) error {
	t.Helper()
	title := []string{"pier", "lighthouse"}[attempt%2]
	err := boundedWriteBesideReader(t, "the update to "+title, func(bounded context.Context) error {
		return narsil.Update(bounded, callbackIndex, "kept", engine.NewDocument().Set("title", title),
			engine.WriteOptions{})
	})
	if err == nil {
		*expected = title
	}
	return err
}

func clearBesideRead(t *testing.T, narsil *engine.Narsil, _ int, expected *string) error {
	t.Helper()
	err := boundedWriteBesideReader(t, "the clear", func(bounded context.Context) error {
		return narsil.Clear(bounded, callbackIndex)
	})
	if err == nil {
		insertReaderHeldSeed(t, narsil)
		*expected = readerHeldSeedTitle
	}
	return err
}

func boundedWriteBesideReader(t *testing.T, label string, write func(bounded context.Context) error) error {
	t.Helper()
	bounded, cancel := context.WithTimeout(context.Background(), readerHeldWriteDeadline)
	defer cancel()
	written := make(chan error, 1)
	go func() {
		written <- write(bounded)
	}()
	select {
	case err := <-written:
		if err != nil && !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("%s beside the read returned %v", label, err)
		}
		return err
	case <-time.After(readerHeldWriteGrace):
		t.Fatalf("%s outlived its deadline while a read held the old version", label)
		return nil
	}
}

func requireOnlyTitle(t *testing.T, narsil *engine.Narsil, expected string) {
	t.Helper()
	ctx := context.Background()
	document, found, err := narsil.Get(ctx, callbackIndex, "kept")
	if err != nil || !found {
		t.Fatalf("the kept document is missing: %v", err)
	}
	if title, _ := document.Get("title"); title != expected {
		t.Fatalf("the document holds %v, expected %s", title, expected)
	}
	for _, term := range []string{readerHeldSeedTitle, "pier", "lighthouse"} {
		want := 0
		if term == expected {
			want = 1
		}
		result, err := narsil.Query(ctx, callbackIndex, engine.QueryParams{Term: term})
		if err != nil || result.Count != want {
			t.Fatalf("searching %q found %d documents, expected %d: %v", term, result.Count, want, err)
		}
	}
}
