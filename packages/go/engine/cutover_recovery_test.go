package engine_test

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

func TestRecoveryUsesTheCommittedRebalanceWhenMetadataKeepsTheEarlierPartitionCount(t *testing.T) {
	for _, storage := range []engine.TextStorage{engine.TextStorageMemory, engine.TextStorageDisk} {
		t.Run(string(storage), func(t *testing.T) {
			ctx := context.Background()
			directory := t.TempDir()
			config := engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)},
				Durability: &engine.DurabilityConfig{Directory: directory, Mode: engine.DurabilitySync,
					CheckpointInterval: engine.Some(time.Duration(0))}}
			open := func() *engine.Narsil {
				narsil, err := engine.New(ctx, config)
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = narsil.Shutdown(ctx) })
				return narsil
			}
			narsil := open()
			if err := narsil.CreateIndex(ctx, "letters", engine.IndexConfig{
				Schema: engine.Schema{"body": engine.FieldString}, TextStorage: storage,
				Partitions: engine.PartitionConfig{MaxPartitions: engine.Some(2)},
			}); err != nil {
				t.Fatal(err)
			}
			expected := make(map[string]string)
			for at := range 20 {
				id, body := fmt.Sprintf("letter-%d", at), fmt.Sprintf("stored letter %d", at)
				expected[id] = body
				if _, err := narsil.Insert(ctx, "letters", engine.NewDocument().Set("body", body), id,
					engine.InsertOptions{}); err != nil {
					t.Fatal(err)
				}
			}
			checkpointOf(t, narsil, "letters")
			path := filepath.Join(directory, "letters", "meta")
			earlier, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if err := narsil.Rebalance(ctx, "letters", 1); err != nil {
				t.Fatal(err)
			}
			shutDown(t, narsil, "after the rebalance")
			if err := os.WriteFile(path, earlier, 0o600); err != nil {
				t.Fatal(err)
			}
			narsil = open()
			for id, body := range expected {
				document, found, err := narsil.Get(ctx, "letters", id)
				if err != nil || !found {
					t.Fatalf("recovery lost %s: %v", id, err)
				}
				if got, _ := document.Get("body"); got != body {
					t.Fatalf("recovery returned %v for %s, expected %s", got, id, body)
				}
			}
			stats, err := narsil.GetStats("letters")
			if err != nil || stats.PartitionCount != 1 || stats.DocumentCount != len(expected) {
				t.Fatalf("recovery ignored the committed layout: %+v, %v", stats, err)
			}
			repaired, err := os.ReadFile(path)
			if err != nil || bytes.Equal(earlier, repaired) {
				t.Fatalf("recovery left the earlier metadata in place: %v", err)
			}
		})
	}
}
