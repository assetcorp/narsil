package engine_test

import (
	"bytes"
	"context"
	"encoding/json"
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
	crashRounds          = 5
	crashPoll            = time.Millisecond
	crashProgressTimeout = 2 * time.Minute
	crashLatestKillDelay = 4 * time.Millisecond
	crashLeastAcks       = 20
	crashMostExtraAcks   = 120
)

type crashLog struct {
	acknowledged []crashStep
	pending      *crashStep
	inCheckpoint bool
	acks         int
}

func parseCrashLog(t *testing.T, data []byte) crashLog {
	t.Helper()
	parsed := crashLog{}
	for _, line := range strings.Split(string(data), "\n") {
		switch {
		case strings.HasPrefix(line, "begin "):
			step := crashStep{}
			if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "begin ")), &step); err != nil {
				parsed.pending = nil
				continue
			}
			parsed.pending = &step
		case line == "ack" && parsed.pending != nil:
			parsed.acknowledged = append(parsed.acknowledged, *parsed.pending)
			parsed.pending = nil
			parsed.acks++
		case line == "checkpoint-start":
			parsed.inCheckpoint = true
		case line == "checkpoint-end":
			parsed.inCheckpoint = false
		}
	}
	return parsed
}

func applyToOracle(oracle map[string]any, step crashStep) {
	for id, document := range step.Documents {
		oracle[id] = document
	}
	if step.Op == "remove" {
		delete(oracle, step.ID)
	}
}

func roundTripped(t *testing.T, value any) any {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("encoding an oracle document failed: %v", err)
	}
	decoded, err := decodedJSON(encoded)
	if err != nil {
		t.Fatalf("decoding an oracle document failed: %v", err)
	}
	return decoded
}

func requireAcknowledgedWrites(t *testing.T, label string, oracle map[string]any, found map[string]any, pending *crashStep) map[string]any {
	t.Helper()
	inFlight := map[string]bool{}
	after := map[string]any{}
	if pending != nil {
		for id := range pending.Documents {
			inFlight[id] = true
		}
		inFlight[pending.ID] = pending.ID != ""
		for id, document := range oracle {
			after[id] = document
		}
		applyToOracle(after, *pending)
	}
	ids := map[string]bool{}
	for id := range oracle {
		ids[id] = true
	}
	for id := range found {
		ids[id] = true
	}
	for id := range after {
		ids[id] = true
	}
	for id := range ids {
		got, gotHeld := found[id]
		matches := func(state map[string]any) bool {
			want, wantHeld := state[id]
			return wantHeld == gotHeld && (!gotHeld || contentDifference(roundTripped(t, want), got, id, false) == "")
		}
		if matches(oracle) || (inFlight[id] && matches(after)) {
			continue
		}
		t.Fatalf("%s: %s is %s after the restart, while the acknowledged writes leave it %s", label, id,
			describeJSON(got), describeJSON(oracle[id]))
	}
	return found
}

func waitForKillPoint(t *testing.T, logPath string, mode string, random *rand.Rand, child *exec.Cmd, exited chan error, stderr *bytes.Buffer) {
	t.Helper()
	wantedAcks := crashLeastAcks + random.Intn(crashMostExtraAcks)
	deadline := time.Now().Add(crashProgressTimeout)
	for time.Now().Before(deadline) {
		select {
		case err := <-exited:
			t.Fatalf("the child stopped before the kill: %v\n%s", err, stderr.String())
		default:
		}
		data, _ := os.ReadFile(logPath)
		parsed := parseCrashLog(t, data)
		if parsed.acks >= wantedAcks && (mode == crashModeInserts || parsed.inCheckpoint) {
			time.Sleep(time.Duration(random.Int63n(int64(crashLatestKillDelay))))
			return
		}
		time.Sleep(crashPoll)
	}
	_ = child.Process.Kill()
	t.Fatalf("the child made no progress to a kill point in %s mode", mode)
}

func reopenedDocuments(t *testing.T, directory string, mode string) map[string]any {
	t.Helper()
	ctx := context.Background()
	narsil, err := engine.New(ctx, engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)},
		Durability: crashDurability(directory, mode)})
	if err != nil {
		t.Fatalf("the engine refused the directory after the kill with %s: %v", codeOrMessage(err), err)
	}
	defer func() {
		if err := narsil.Shutdown(ctx); err != nil {
			t.Fatalf("the engine failed to shut down after the restart: %v", err)
		}
	}()
	if len(narsil.ListIndexes()) == 0 {
		return map[string]any{}
	}
	found, err := exportedDocuments(ctx, narsil, crashIndexName)
	if err != nil {
		t.Fatalf("exporting after the restart failed with %s: %v", codeOrMessage(err), err)
	}
	return found
}

func TestCrashKeepsEveryAcknowledgedWrite(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatalf("finding the test binary failed: %v", err)
	}
	for modeNumber, mode := range []string{crashModeInserts, crashModeCheckpoints, crashModeMerges} {
		t.Run(mode, func(t *testing.T) {
			directory := t.TempDir()
			random := rand.New(rand.NewSource(int64(174 + modeNumber)))
			oracle := map[string]any{}
			insideCheckpoints := 0
			for round := range crashRounds {
				logPath := filepath.Join(t.TempDir(), "journal.log")
				child := exec.Command(executable, "-test.run=^$")
				child.Env = append(os.Environ(), crashDirectoryVariable+"="+directory, crashLogVariable+"="+logPath,
					crashModeVariable+"="+mode, fmt.Sprintf("%s=%d", crashSeedVariable, random.Int63()))
				var stderr bytes.Buffer
				child.Stderr = &stderr
				if err := child.Start(); err != nil {
					t.Fatalf("starting the child failed: %v", err)
				}
				exited := make(chan error, 1)
				go func() { exited <- child.Wait() }()
				waitForKillPoint(t, logPath, mode, random, child, exited, &stderr)
				if err := child.Process.Kill(); err != nil {
					t.Fatalf("killing the child failed: %v", err)
				}
				<-exited
				if strings.Contains(stderr.String(), "DATA RACE") {
					t.Fatalf("the race detector reported a race in the child:\n%s", stderr.String())
				}
				data, err := os.ReadFile(logPath)
				if err != nil {
					t.Fatalf("reading the child's journal failed: %v", err)
				}
				parsed := parseCrashLog(t, data)
				if parsed.inCheckpoint {
					insideCheckpoints++
				}
				for _, step := range parsed.acknowledged {
					applyToOracle(oracle, step)
				}
				label := fmt.Sprintf("round %d after %d acknowledged steps (stderr %q)", round, parsed.acks, stderr.String())
				oracle = requireAcknowledgedWrites(t, label, oracle, reopenedDocuments(t, directory, mode), parsed.pending)
			}
			if mode != crashModeInserts && insideCheckpoints == 0 {
				t.Fatalf("no kill landed inside a checkpoint in %d rounds", crashRounds)
			}
		})
	}
}
