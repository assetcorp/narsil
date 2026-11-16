package engine_test

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	cutoverWriters         = 8
	cutoverSwitches        = 30
	retiringWriters        = 1
	retiringSwitches       = 800
	reentrantTokenPrefix   = "r"
	cutoverWrittenPrefix   = "written "
	cutoverChildDeadline   = 30 * time.Second
	cutoverChildTestLimit  = "20s"
	cutoverNeverWritten    = -1
	cutoverSeedTitle       = "seed"
	cutoverChildVariable   = "NARSIL_WRITE_CUTOVER_CHILD"
	retiringChildVariable  = "NARSIL_RETIRING_CUTOVER_CHILD"
	cutoverChildRunPattern = "-test.run=^%s$"
)

func reentrantWords(text string) []engine.Token {
	tokens := lowercaseWords(text)
	for at := range tokens {
		tokens[at].Token = reentrantTokenPrefix + tokens[at].Token
	}
	return tokens
}

func cutoverMarker(writer, update int) string {
	return fmt.Sprintf("w%du%d", writer, update)
}

func inCutoverChild(t *testing.T, variable string) bool {
	t.Helper()
	if os.Getenv(variable) != "" {
		return true
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), cutoverChildDeadline)
	defer cancel()
	child := exec.CommandContext(ctx, executable, fmt.Sprintf(cutoverChildRunPattern, t.Name()),
		"-test.timeout="+cutoverChildTestLimit)
	child.Env = append(os.Environ(), variable+"=1")
	if output, err := child.CombinedOutput(); err != nil {
		t.Fatalf("writes overlapping analysis switches failed or deadlocked: %v\n%s", err, output)
	}
	return false
}

func TestWritesRecheckTheirAnalysisAfterWaitingForACutover(t *testing.T) {
	if inCutoverChild(t, cutoverChildVariable) {
		writeAcrossCutovers(t, cutoverWriters, cutoverSwitches)
	}
}

func TestAWriteKeepsTheIndexItReadWhenACutoverRetiresIt(t *testing.T) {
	if inCutoverChild(t, retiringChildVariable) {
		writeAcrossCutovers(t, retiringWriters, retiringSwitches)
	}
}

func writeAcrossCutovers(t *testing.T, writers int, switches int) {
	ctx := context.Background()
	var narsil *engine.Narsil
	nested := &nestedErrors{}
	tokenizer := splitTokenizer(func(text string) []engine.Token {
		if strings.HasPrefix(text, cutoverWrittenPrefix) {
			err := narsil.Remove(ctx, callbackIndex, "absent", engine.WriteOptions{})
			if code := engine.ErrorCode(err); code != engine.CodeDocNotFound && code != engine.CodeWorkerBusy {
				nested.note(fmt.Errorf("the nested removal returned %v", err))
			}
		}
		return reentrantWords(text)
	})
	var err error
	narsil, err = engine.New(ctx, engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)},
		Tokenizers: map[string]engine.Tokenizer{"reentrant": tokenizer}})
	if err != nil {
		t.Fatal(err)
	}
	defer shutDownWithin(t, narsil, "after the concurrent switches")
	if err := narsil.CreateIndex(ctx, callbackIndex, engine.IndexConfig{
		Schema: engine.Schema{"title": engine.FieldString},
	}); err != nil {
		t.Fatal(err)
	}
	for writer := range writers {
		if _, err := narsil.Insert(ctx, callbackIndex, engine.NewDocument().Set("title", cutoverSeedTitle),
			fmt.Sprintf("item-%d", writer), engine.InsertOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	var switching atomic.Bool
	switching.Store(true)
	last := make([]int, writers)
	for writer := range last {
		last[writer] = cutoverNeverWritten
	}
	var pending sync.WaitGroup
	for writer := range writers {
		pending.Go(func() {
			for update := 0; switching.Load(); update++ {
				err := narsil.Update(ctx, callbackIndex, fmt.Sprintf("item-%d", writer),
					engine.NewDocument().Set("title", cutoverWrittenPrefix+cutoverMarker(writer, update)), engine.WriteOptions{})
				if engine.ErrorCode(err) == engine.CodeWorkerBusy {
					continue
				}
				if err != nil {
					nested.note(err)
					return
				}
				last[writer] = update
			}
		})
	}
	for change := range switches {
		tokenizer := engine.ChangeToRegisteredTokenizer("reentrant")
		if change%2 != 0 {
			tokenizer = engine.ResetTokenizer()
		}
		if err := narsil.ChangeAnalysis(ctx, callbackIndex, engine.AnalysisChange{Tokenizer: tokenizer}); err != nil {
			switching.Store(false)
			pending.Wait()
			t.Fatal(err)
		}
	}
	switching.Store(false)
	pending.Wait()
	if err := nested.first(); err != nil {
		t.Fatal(err)
	}
	requireCutoverWritesUnderTheFinalAnalysis(t, narsil, last)
}

func requireCutoverWritesUnderTheFinalAnalysis(t *testing.T, narsil *engine.Narsil, last []int) {
	t.Helper()
	ctx := context.Background()
	for writer, update := range last {
		id, marker := fmt.Sprintf("item-%d", writer), cutoverMarker(writer, update)
		document, found, err := narsil.Get(ctx, callbackIndex, id)
		if err != nil || !found {
			t.Fatalf("the final document %s is missing: %v", id, err)
		}
		if update == cutoverNeverWritten {
			if value, _ := document.Get("title"); value != cutoverSeedTitle {
				t.Fatalf("document %s holds %v after every update was refused", id, value)
			}
			continue
		}
		if value, _ := document.Get("title"); value != cutoverWrittenPrefix+marker {
			t.Fatalf("document %s holds %v, expected %s%s", id, value, cutoverWrittenPrefix, marker)
		}
		current, err := narsil.Query(ctx, callbackIndex, engine.QueryParams{Term: marker})
		if err != nil || current.Count != 1 || len(current.Hits) != 1 || current.Hits[0].ID != id {
			t.Fatalf("searching %q under the final tokenizer found %+v, expected only %s: %v", marker, current, id, err)
		}
		stale, err := narsil.Query(ctx, callbackIndex, engine.QueryParams{Term: reentrantTokenPrefix + marker})
		if err != nil || stale.Count != 0 {
			t.Fatalf("document %s kept tokens from the replaced tokenizer: %d hits, %v", id, stale.Count, err)
		}
	}
}
