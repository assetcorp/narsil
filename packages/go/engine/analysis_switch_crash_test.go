package engine_test

import (
	"bytes"
	"context"
	"fmt"
	"math/rand"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	switchCrashDirectoryVariable = "NARSIL_SWITCH_CRASH_DIRECTORY"
	switchCrashLogVariable       = "NARSIL_SWITCH_CRASH_LOG"
	switchCrashRoundVariable     = "NARSIL_SWITCH_CRASH_ROUND"
	switchCrashIndex             = "harbours"
	switchCrashFill              = 2000
	switchCrashFillBatch         = 250
	switchCrashWriteBatch        = 20
	switchCrashRounds            = 10
	switchCrashLeastAcks         = 3
	switchCrashLatestKillDelay   = 40 * time.Millisecond
	switchCrashKillPoints        = 5
	switchCrashPoll              = 100 * time.Microsecond
	switchCrashWholeTerm         = "pier-zed"
	switchCrashHalfTerm          = "zed"
)

func switchCrashEngine(directory string) (*engine.Narsil, error) {
	return engine.New(context.Background(), engine.Config{
		Tokenizers: map[string]engine.Tokenizer{ruleWordsTokenizer: splitTokenizer(lowercaseWords),
			ruleDashTokenizer: splitTokenizer(dashedWords)},
		Workers: engine.WorkerConfig{Enabled: engine.Some(false)},
		Durability: &engine.DurabilityConfig{Directory: directory, Mode: engine.DurabilitySync,
			CheckpointInterval: engine.Some(time.Duration(0)), CheckpointMutationThreshold: engine.Some(crashDistantThreshold)},
	})
}

func switchCrashBatch(ids []string) []*engine.Document {
	batch := make([]*engine.Document, len(ids))
	for at, id := range ids {
		batch[at] = engine.DocumentFromMap(map[string]any{"id": id, "title": "harbour-" + id + " " + switchCrashWholeTerm})
	}
	return batch
}

func journaledInsert(ctx context.Context, narsil *engine.Narsil, journal *crashJournal, ids []string) error {
	if err := journal.note("begin " + strings.Join(ids, ",")); err != nil {
		return err
	}
	result, err := narsil.InsertBatch(ctx, switchCrashIndex, switchCrashBatch(ids), engine.InsertOptions{})
	if err != nil {
		return err
	}
	if len(result.Failed) > 0 {
		return result.Failed[0].Err
	}
	return journal.note("ack")
}

func runSwitchCrashChild(directory string, logPath string, round string) error {
	ctx := context.Background()
	file, err := os.OpenFile(logPath, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	journal := &crashJournal{file: file}
	narsil, err := switchCrashEngine(directory)
	if err != nil {
		return err
	}
	if len(narsil.ListIndexes()) == 0 {
		if err := narsil.CreateIndex(ctx, switchCrashIndex, engine.IndexConfig{Schema: engine.Schema{"title": engine.FieldString},
			Tokenizer: engine.NamedTokenizer(ruleWordsTokenizer)}); err != nil {
			return err
		}
		for first := 0; first < switchCrashFill; first += switchCrashFillBatch {
			ids := make([]string, switchCrashFillBatch)
			for at := range ids {
				ids[at] = fmt.Sprintf("fill-%05d", first+at)
			}
			if err := journaledInsert(ctx, narsil, journal, ids); err != nil {
				return err
			}
		}
	}
	failed := make(chan error, 1)
	go func() {
		for batch := 0; ; batch++ {
			ids := make([]string, switchCrashWriteBatch)
			for at := range ids {
				ids[at] = fmt.Sprintf("r%s-%06d", round, batch*switchCrashWriteBatch+at)
			}
			if err := journaledInsert(ctx, narsil, journal, ids); err != nil {
				failed <- err
				return
			}
		}
	}()
	for change := 0; ; change++ {
		select {
		case err := <-failed:
			return err
		default:
		}
		target := []string{ruleDashTokenizer, ruleWordsTokenizer}[change%2]
		if err := narsil.Checkpoint(ctx, switchCrashIndex); err != nil {
			return err
		}
		if err := journal.note("change-start"); err != nil {
			return err
		}
		err := narsil.ChangeAnalysis(ctx, switchCrashIndex,
			engine.AnalysisChange{Tokenizer: engine.ChangeToRegisteredTokenizer(target)})
		if err != nil {
			return err
		}
		if err := journal.note("change-end"); err != nil {
			return err
		}
	}
}

type switchCrashLog struct {
	acknowledged []string
	pending      []string
	inChange     bool
	acks         int
}

func parseSwitchCrashLog(data []byte) switchCrashLog {
	parsed := switchCrashLog{}
	for _, line := range strings.Split(string(data), "\n") {
		switch {
		case strings.HasPrefix(line, "begin "):
			parsed.pending = strings.Split(strings.TrimPrefix(line, "begin "), ",")
		case line == "ack":
			parsed.acknowledged = append(parsed.acknowledged, parsed.pending...)
			parsed.pending = nil
			parsed.acks++
		case line == "change-start":
			parsed.inChange = true
		case line == "change-end":
			parsed.inChange = false
		}
	}
	return parsed
}

type switchKillPoint struct {
	directory   string
	random      *rand.Rand
	afterWrites int
	buildFiles  bool
	baseline    []byte
	writes      int
}

func (point *switchKillPoint) committedFiles() []byte {
	meta, _ := readWhileTheEngineReplacesIt(filepath.Join(point.directory, switchCrashIndex, "meta"))
	listed, _ := readWhileTheEngineReplacesIt(filepath.Join(point.directory, switchCrashIndex, "manifest"))
	return append(meta, listed...)
}

func (point *switchKillPoint) reached(inChange bool) bool {
	if !inChange {
		point.baseline, point.writes = nil, 0
		return false
	}
	if point.buildFiles {
		built, err := uncommittedBuildFiles(point.directory, switchCrashIndex)
		return err == nil && len(built) > 0
	}
	if point.afterWrites == 0 {
		time.Sleep(time.Duration(point.random.Int63n(int64(switchCrashLatestKillDelay))))
		return true
	}
	current := point.committedFiles()
	if point.baseline == nil {
		point.baseline = current
		return false
	}
	if !bytes.Equal(current, point.baseline) {
		point.baseline = current
		point.writes++
	}
	return point.writes >= point.afterWrites
}

func killDuringASwitch(t *testing.T, child *exec.Cmd, logPath string, point *switchKillPoint,
	stderr *bytes.Buffer) switchCrashLog {
	t.Helper()
	exited := make(chan error, 1)
	go func() { exited <- child.Wait() }()
	deadline := time.Now().Add(crashProgressTimeout)
	for time.Now().Before(deadline) {
		select {
		case err := <-exited:
			t.Fatalf("the child stopped before the kill: %v\n%s", err, stderr.String())
		default:
		}
		data, _ := os.ReadFile(logPath)
		parsed := parseSwitchCrashLog(data)
		if point.reached(parsed.acks >= switchCrashLeastAcks && parsed.inChange) {
			if err := child.Process.Kill(); err != nil {
				t.Fatalf("killing the child failed: %v", err)
			}
			<-exited
			data, _ = os.ReadFile(logPath)
			return parseSwitchCrashLog(data)
		}
		time.Sleep(switchCrashPoll)
	}
	_ = child.Process.Kill()
	t.Fatalf("the child never reached its kill point within %s", crashProgressTimeout)
	return switchCrashLog{}
}

func termCount(t *testing.T, narsil *engine.Narsil, term string) int {
	t.Helper()
	result, err := narsil.Query(context.Background(), switchCrashIndex, engine.QueryParams{Term: term})
	if err != nil {
		t.Fatalf("a search for %q after the restart failed with %s: %v", term, codeOrMessage(err), err)
	}
	return result.Count
}

func requireRecoveredSwitch(t *testing.T, directory string, label string, acknowledged map[string]bool,
	pending []string) map[string]any {
	t.Helper()
	narsil, err := switchCrashEngine(directory)
	if err != nil {
		t.Fatalf("%s, the engine refused the directory with %s: %v", label, codeOrMessage(err), err)
	}
	defer shutDownWithin(t, narsil, label)
	requireNoStrayFiles(t, directory, switchCrashIndex, label)
	found, err := exportedDocuments(context.Background(), narsil, switchCrashIndex)
	if err != nil {
		t.Fatalf("%s, exporting failed with %s: %v", label, codeOrMessage(err), err)
	}
	inFlight := map[string]bool{}
	for _, id := range pending {
		inFlight[id] = true
	}
	for id := range acknowledged {
		if _, held := found[id]; !held {
			t.Fatalf("%s, the acknowledged document %s is missing", label, id)
		}
	}
	for id := range found {
		if !acknowledged[id] && !inFlight[id] {
			t.Fatalf("%s, the index holds %s, which no write began", label, id)
		}
	}
	if whole := termCount(t, narsil, switchCrashWholeTerm); whole != len(found) {
		t.Fatalf("%s, a search for %q found %d of %d documents, so the terms mix two analyses", label,
			switchCrashWholeTerm, whole, len(found))
	}
	if half := termCount(t, narsil, switchCrashHalfTerm); half != 0 && half != len(found) {
		t.Fatalf("%s, a search for %q found %d of %d documents, so the terms mix two analyses", label,
			switchCrashHalfTerm, half, len(found))
	}
	return found
}

func TestACrashDuringAnAnalysisSwitchRecoversWhollyUnderOneAnalysis(t *testing.T) {
	t.Parallel()
	executable, err := os.Executable()
	if err != nil {
		t.Fatalf("finding the test binary failed: %v", err)
	}
	directory := t.TempDir()
	random := rand.New(rand.NewSource(281))
	acknowledged := map[string]bool{}
	insideSwitches := 0
	for round := range switchCrashRounds {
		logPath := filepath.Join(t.TempDir(), "journal.log")
		child := exec.Command(executable, "-test.run=^$")
		child.Env = append(os.Environ(), switchCrashDirectoryVariable+"="+directory, switchCrashLogVariable+"="+logPath,
			fmt.Sprintf("%s=%d", switchCrashRoundVariable, round))
		var stderr bytes.Buffer
		child.Stderr = &stderr
		if err := child.Start(); err != nil {
			t.Fatalf("starting the child failed: %v", err)
		}
		step := round % switchCrashKillPoints
		point := &switchKillPoint{directory: directory, random: random, afterWrites: step,
			buildFiles: step == switchCrashKillPoints-1}
		parsed := killDuringASwitch(t, child, logPath, point, &stderr)
		if strings.Contains(stderr.String(), "DATA RACE") {
			t.Fatalf("the race detector reported a race in the child:\n%s", stderr.String())
		}
		for _, id := range parsed.acknowledged {
			acknowledged[id] = true
		}
		if parsed.inChange {
			insideSwitches++
		}
		found := requireRecoveredSwitch(t, directory, fmt.Sprintf("after the kill in round %d", round), acknowledged,
			parsed.pending)
		for _, id := range parsed.pending {
			if _, held := found[id]; held {
				acknowledged[id] = true
			}
		}
	}
	if insideSwitches < switchCrashRounds/2 {
		t.Fatalf("only %d of %d kills landed inside an analysis change", insideSwitches, switchCrashRounds)
	}
}
