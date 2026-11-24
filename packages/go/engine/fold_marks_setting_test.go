package engine_test

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	foldSettingCorpusSize   = 90
	foldSettingCorpusSeed   = 11
	foldCrashCorpusSeed     = 23
	foldSettingQuery        = "oko"
	foldSettingPartitions   = 2
	foldCrashRounds         = 6
	foldCrashChildDirectory = "NARSIL_FOLD_MARKS_CRASH_DIRECTORY"
	foldCrashSwitchedLine   = "SWITCHED"
)

func foldedIDs(documents []wordDocument) []string {
	return idsWithWord(documents, func(word string) bool { return yorubaFold(word) == foldSettingQuery })
}

func writtenIDs(documents []wordDocument) []string {
	return idsWithWord(documents, func(word string) bool { return word == foldSettingQuery })
}

func foundIDs(t *testing.T, narsil *engine.Narsil) []string {
	t.Helper()
	return foldHitIDs(t, narsil, foldIndexName, termQuery(foldSettingQuery))
}

func foldDurability(directory string) *engine.DurabilityConfig {
	return &engine.DurabilityConfig{Directory: directory, Mode: engine.DurabilitySync}
}

func openFoldEngine(directory string) (*engine.Narsil, error) {
	return engine.New(context.Background(), engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)},
		Durability: foldDurability(directory)})
}

func durableFoldEngine(t *testing.T, directory string) *engine.Narsil {
	t.Helper()
	narsil, err := openFoldEngine(directory)
	if err != nil {
		t.Fatalf("the engine refused to open: %v", err)
	}
	return narsil
}

func changeFoldMarks(t *testing.T, narsil *engine.Narsil, change engine.FoldMarksChange, label string) {
	t.Helper()
	if err := narsil.ChangeAnalysis(context.Background(), foldIndexName, engine.AnalysisChange{FoldMarks: change}); err != nil {
		t.Fatalf("%s: the change was refused: %v", label, err)
	}
}

func countedRebuilds(narsil *engine.Narsil) *atomic.Int64 {
	rebuilds := &atomic.Int64{}
	narsil.On(engine.EventHandlers{AnalysisRebuild: func(engine.AnalysisRebuildEvent) { rebuilds.Add(1) }})
	return rebuilds
}

func TestFoldMarksSwitchWithoutARebuildAndRestartsKeepEachSetting(t *testing.T) {
	directory := t.TempDir()
	documents := generatedDocuments(foldSettingCorpusSize, yorubaWords, foldSettingCorpusSeed)
	requireDistinctSettings(t, documents)
	narsil := durableFoldEngine(t, directory)
	config := textIndex("yoruba", bodySchema())
	config.Partitions = engine.PartitionConfig{MaxPartitions: engine.Some(foldSettingPartitions)}
	createIndex(t, narsil, foldIndexName, config)
	insertWords(t, narsil, foldIndexName, documents)
	if err := narsil.Rebalance(context.Background(), foldIndexName, foldSettingPartitions); err != nil {
		t.Fatalf("the index did not spread over two partitions: %v", err)
	}
	requireIDs(t, "the language default", foundIDs(t, narsil), foldedIDs(documents))
	rebuilds := countedRebuilds(narsil)
	changeFoldMarks(t, narsil, engine.ChangeFoldMarks(false), "folding off")
	requireIDs(t, "folding off", foundIDs(t, narsil), writtenIDs(documents))
	changeFoldMarks(t, narsil, engine.ChangeFoldMarks(false), "the same setting again")
	if rebuilds.Load() != 0 {
		t.Fatalf("a fold change rebuilt the terms %d times", rebuilds.Load())
	}
	shutDown(t, narsil, "after the fold changes")

	narsil = durableFoldEngine(t, directory)
	requireIDs(t, "folding off after a restart", foundIDs(t, narsil), writtenIDs(documents))
	rebuilds = countedRebuilds(narsil)
	changeFoldMarks(t, narsil, engine.ResetFoldMarks(), "back to the language default")
	requireIDs(t, "the language default again", foundIDs(t, narsil), foldedIDs(documents))
	if rebuilds.Load() != 0 {
		t.Fatalf("a fold change rebuilt the terms %d times", rebuilds.Load())
	}
	later := pairedDocuments([2]string{"later-marked", "ọkọ̀ ìwé"}, [2]string{"later-plain", "oko ile"})
	insertWords(t, narsil, foldIndexName, later)
	shutDown(t, narsil, "after the fold changes")

	narsil = durableFoldEngine(t, directory)
	defer shutDown(t, narsil, "after the fold changes")
	requireIDs(t, "after the last restart", foundIDs(t, narsil), foldedIDs(append(documents, later...)))
}

func TestASnapshotCarriesFoldMarksToAnotherEngine(t *testing.T) {
	documents := generatedDocuments(foldSettingCorpusSize, yorubaWords, foldSettingCorpusSeed)
	narsil := durableFoldEngine(t, t.TempDir())
	defer shutDown(t, narsil, "after the fold changes")
	config := textIndex("yoruba", bodySchema())
	config.FoldMarks = engine.Some(false)
	createIndex(t, narsil, foldIndexName, config)
	insertWords(t, narsil, foldIndexName, documents)
	var archive bytes.Buffer
	if err := narsil.Snapshot(context.Background(), foldIndexName, engine.SnapshotOptions{}, &archive); err != nil {
		t.Fatalf("the snapshot failed: %v", err)
	}
	copied := memoryEngine(t)
	if err := copied.Restore(context.Background(), foldIndexName, &archive); err != nil {
		t.Fatalf("the snapshot did not restore: %v", err)
	}
	requireIDs(t, "the restored copy", foundIDs(t, copied), writtenIDs(documents))
	changeFoldMarks(t, copied, engine.ChangeFoldMarks(true), "folding on in the copy")
	requireIDs(t, "the copy with folding on", foundIDs(t, copied), foldedIDs(documents))
	requireIDs(t, "the original", foundIDs(t, narsil), writtenIDs(documents))
}

func requireDistinctSettings(t *testing.T, documents []wordDocument) {
	t.Helper()
	if strings.Join(foldedIDs(documents), ",") == strings.Join(writtenIDs(documents), ",") {
		t.Fatal("the corpus matches the same documents under both settings")
	}
}

func runFoldMarksCrashChild(directory string, out io.Writer) error {
	ctx := context.Background()
	narsil, err := openFoldEngine(directory)
	if err != nil {
		return err
	}
	if _, err := narsil.CountDocuments(ctx, foldIndexName); err != nil {
		if err := narsil.CreateIndex(ctx, foldIndexName, textIndex("yoruba", bodySchema())); err != nil {
			return err
		}
		documents := generatedDocuments(foldSettingCorpusSize, yorubaWords, foldCrashCorpusSeed)
		batch := make([]*engine.Document, len(documents))
		for at, document := range documents {
			batch[at] = engine.NewDocument().Set("id", document.id).Set("body", document.body)
		}
		if _, err := narsil.InsertBatch(ctx, foldIndexName, batch, engine.InsertOptions{}); err != nil {
			return err
		}
		if err := narsil.Checkpoint(ctx, foldIndexName); err != nil {
			return err
		}
	}
	for {
		for _, on := range []bool{false, true} {
			change := engine.AnalysisChange{FoldMarks: engine.ChangeFoldMarks(on)}
			if err := narsil.ChangeAnalysis(ctx, foldIndexName, change); err == nil {
				fmt.Fprintln(out, foldCrashSwitchedLine)
			}
		}
	}
}

func killedAfterFoldSwitches(t *testing.T, executable string, directory string, switches int) bool {
	t.Helper()
	child := exec.Command(executable, "-test.run=^$")
	child.Env = append(os.Environ(), foldCrashChildDirectory+"="+directory)
	output, err := child.StdoutPipe()
	if err != nil {
		t.Fatalf("piping the child's output failed: %v", err)
	}
	if err := child.Start(); err != nil {
		t.Fatalf("starting the child failed: %v", err)
	}
	seen := 0
	lines := bufio.NewScanner(output)
	for seen < switches && lines.Scan() {
		if lines.Text() == foldCrashSwitchedLine {
			seen++
		}
	}
	_ = child.Process.Kill()
	_ = child.Wait()
	return seen > 0
}

func TestAKillDuringFoldMarksChangesReopensUnderOneSetting(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatalf("finding the test binary failed: %v", err)
	}
	directory := t.TempDir()
	documents := generatedDocuments(foldSettingCorpusSize, yorubaWords, foldCrashCorpusSeed)
	requireDistinctSettings(t, documents)
	for round := range foldCrashRounds {
		if !killedAfterFoldSwitches(t, executable, directory, 1+round%3) {
			t.Fatalf("round %d switched no setting", round)
		}
		narsil, err := openFoldEngine(directory)
		if err != nil {
			t.Fatalf("round %d failed to recover: %v", round, err)
		}
		if err := narsil.RebuildAnalysis(context.Background(), foldIndexName); err != nil {
			t.Fatalf("round %d failed to finish the change: %v", round, err)
		}
		count, err := narsil.CountDocuments(context.Background(), foldIndexName)
		if err != nil || count != len(documents) {
			t.Fatalf("round %d holds %d documents (%v), want %d", round, count, err, len(documents))
		}
		found := foundIDs(t, narsil)
		if folded, written := strings.Join(foldedIDs(documents), ","), strings.Join(writtenIDs(documents), ","); strings.Join(found, ",") != folded && strings.Join(found, ",") != written {
			t.Fatalf("round %d matched %v, which is neither setting", round, found)
		}
		shutDown(t, narsil, "after the fold changes")
	}
}
