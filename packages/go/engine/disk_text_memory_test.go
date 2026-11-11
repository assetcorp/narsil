package engine_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	checkpointedBursts       = 6
	documentsPerBurst        = 120
	pastIdleMergeDelay       = 1_500 * time.Millisecond
	residentShareOfTextBytes = 0.5
)

type checkpointedEngine struct {
	label     string
	narsil    *engine.Narsil
	directory string
	ledger    *diskTextLedger
	waits     bool
	estimates []int64
}

func checkpointedNarsil(t *testing.T, label string, directory string) *engine.Narsil {
	t.Helper()
	narsil, err := engine.New(context.Background(), engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)},
		Durability: &engine.DurabilityConfig{Directory: directory, Mode: engine.DurabilitySync}})
	if err != nil {
		t.Fatalf("the %s engine refused to start with %s: %v", label, codeOrMessage(err), err)
	}
	return narsil
}

func startCheckpointedEngine(t *testing.T, label string, waits bool) *checkpointedEngine {
	t.Helper()
	directory := t.TempDir()
	narsil := checkpointedNarsil(t, label, directory)
	if err := narsil.CreateIndex(context.Background(), diskTextIndex, engine.IndexConfig{
		Schema: engine.Schema{"body": engine.FieldString}, Language: "english",
		TextStorage: engine.TextStorageDisk}); err != nil {
		t.Fatalf("the %s engine refused the index with %s: %v", label, codeOrMessage(err), err)
	}
	return &checkpointedEngine{label: label, narsil: narsil, directory: directory,
		ledger: &diskTextLedger{bodies: map[string]string{}}, waits: waits}
}

func (held *checkpointedEngine) estimate(t *testing.T, moment string) int64 {
	t.Helper()
	stats, err := held.narsil.GetStats(diskTextIndex)
	if err != nil {
		t.Fatalf("%s, the %s engine refused its statistics with %s: %v", moment, held.label, codeOrMessage(err), err)
	}
	if stats.DocumentCount != len(held.ledger.bodies) {
		t.Fatalf("%s, the %s engine counts %d documents where %d are acknowledged", moment, held.label,
			stats.DocumentCount, len(held.ledger.bodies))
	}
	return stats.EstimatedMemoryBytes
}

func (held *checkpointedEngine) burst(t *testing.T, burst int) {
	t.Helper()
	moment := fmt.Sprintf("after the checkpoint of burst %d", burst+1)
	held.ledger.insert(t, held.narsil, documentsPerBurst)
	if held.waits {
		time.Sleep(pastIdleMergeDelay)
	}
	diskTextCheckpoint(t, held.narsil, moment)
	held.estimates = append(held.estimates, held.estimate(t, moment))
	held.ledger.requireAnswers(t, held.narsil, moment+" on the "+held.label+" engine")
}

func textBytesOf(ledger *diskTextLedger, from int, to int) int64 {
	var total int64
	for serial := from; serial < to; serial++ {
		id := diskTextID(serial)
		total += int64(len(id) + len(ledger.bodies[id]))
	}
	return total
}

func TestTextStoredOnDiskLeavesNoCheckpointedTextInMemory(t *testing.T) {
	t.Parallel()
	engines := []*checkpointedEngine{startCheckpointedEngine(t, "idle", true),
		startCheckpointedEngine(t, "busy", false)}
	for burst := range checkpointedBursts {
		for _, held := range engines {
			held.burst(t, burst)
		}
	}
	idle, busy := engines[0], engines[1]
	for burst := range checkpointedBursts {
		if idle.estimates[burst] != busy.estimates[burst] {
			t.Fatalf("after the checkpoint of burst %d, the engine that waited for idle merges estimates %d bytes and the engine that did not estimates %d",
				burst+1, idle.estimates[burst], busy.estimates[burst])
		}
	}
	added := textBytesOf(idle.ledger, documentsPerBurst, checkpointedBursts*documentsPerBurst)
	growth := idle.estimates[checkpointedBursts-1] - idle.estimates[0]
	if float64(growth) > float64(added)*residentShareOfTextBytes {
		t.Fatalf("the estimate grew by %d bytes across %d checkpointed bursts that added %d bytes of text, so the checkpointed text stays in memory: %v",
			growth, checkpointedBursts-1, added, idle.estimates)
	}
	for _, held := range engines {
		held.ledger.requireExport(t, held.narsil, "before the restart of the "+held.label+" engine")
	}

	before := idle.estimates[checkpointedBursts-1]
	shutDown(t, idle.narsil, "before the restart")
	reopened := checkpointedNarsil(t, idle.label, idle.directory)
	defer shutDown(t, reopened, "at the end")
	defer shutDown(t, busy.narsil, "at the end")
	idle.narsil = reopened
	after := idle.estimate(t, "after the restart")
	if float64(after-before) > float64(added)*residentShareOfTextBytes {
		t.Fatalf("the estimate grew from %d bytes to %d across a restart that loaded no new text", before, after)
	}
	idle.ledger.requireAnswers(t, reopened, "after the restart")
	idle.ledger.requireExport(t, reopened, "after the restart")
}
