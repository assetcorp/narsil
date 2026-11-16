package engine_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"runtime"
	"runtime/debug"
	"runtime/metrics"
	"strings"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	rebuildMemoryChildVariable = "NARSIL_REBUILD_MEMORY_CHILD"
	rebuildMemoryDocuments     = 3000
	rebuildMemoryBatch         = 500
	rebuildMemoryWordsPerTitle = 24
	rebuildMemoryChildTimeout  = 2 * time.Minute
	liveHeapObjectsMetric      = "/memory/classes/heap/objects:bytes"

	rebuildMemoryRoomForHalfTheTerms = "half-the-terms"
	rebuildMemoryRoomForTermsAlone   = "terms-alone"
)

type rebuildMemoryOutcome struct {
	Code     string `json:"code"`
	Mismatch string `json:"mismatch"`
}

func rebuildMemoryTitle(at int) string {
	words := make([]string, rebuildMemoryWordsPerTitle)
	for word := range words {
		words[word] = fmt.Sprintf("w%dx%d", at, word)
	}
	return fmt.Sprintf("harbour-q%04d ", at) + strings.Join(words, " ")
}

func liveHeapBytes() int64 {
	runtime.GC()
	sample := []metrics.Sample{{Name: liveHeapObjectsMetric}}
	metrics.Read(sample)
	return int64(sample[0].Value.Uint64())
}

func rebuildMemoryMismatch(ctx context.Context, narsil *engine.Narsil) (string, error) {
	for _, at := range []int{0, rebuildMemoryDocuments / 2, rebuildMemoryDocuments - 1, rebuildMemoryDocuments} {
		for term, want := range map[string]int{fmt.Sprintf("harbour-q%04d", at): 1, fmt.Sprintf("q%04d", at): 0} {
			result, err := narsil.Query(ctx, callbackIndex, engine.QueryParams{Term: term})
			if err != nil {
				return "", err
			}
			if result.Count != want {
				return fmt.Sprintf("a search for %q found %d documents, not %d", term, result.Count, want), nil
			}
		}
	}
	return "", nil
}

func freeHeapFor(room string, termBytes int64) int64 {
	if room == rebuildMemoryRoomForTermsAlone {
		return 2 * termBytes
	}
	return termBytes / 2
}

func runRebuildMemoryChild(out io.Writer, room string) error {
	ctx := context.Background()
	narsil, err := engine.New(ctx, engine.Config{
		Tokenizers: map[string]engine.Tokenizer{ruleWordsTokenizer: splitTokenizer(lowercaseWords),
			ruleDashTokenizer: splitTokenizer(dashedWords)},
		Workers: engine.WorkerConfig{Enabled: engine.Some(false)},
		Memory:  engine.MemoryConfig{BlockWritesAbove: engine.Some(1.0), ResumeWritesBelow: engine.Some(0.99)},
	})
	if err != nil {
		return err
	}
	if err := narsil.CreateIndex(ctx, callbackIndex, engine.IndexConfig{Schema: engine.Schema{"title": engine.FieldString},
		Tokenizer: engine.NamedTokenizer(ruleWordsTokenizer)}); err != nil {
		return err
	}
	for first := 0; first < rebuildMemoryDocuments; first += rebuildMemoryBatch {
		batch := make([]*engine.Document, 0, rebuildMemoryBatch)
		for at := first; at < first+rebuildMemoryBatch; at++ {
			batch = append(batch, engine.DocumentFromMap(map[string]any{"id": ruleID(at), "title": rebuildMemoryTitle(at)}))
		}
		if _, err := narsil.InsertBatch(ctx, callbackIndex, batch, engine.InsertOptions{}); err != nil {
			return err
		}
	}
	stats, err := narsil.GetMemoryStats(ctx)
	if err != nil {
		return err
	}
	debug.SetMemoryLimit(liveHeapBytes() + freeHeapFor(room, stats.EstimatedIndexBytes))
	refused := narsil.ChangeAnalysis(ctx, callbackIndex,
		engine.AnalysisChange{Tokenizer: engine.ChangeToRegisteredTokenizer(ruleDashTokenizer)})
	debug.SetMemoryLimit(math.MaxInt64)
	outcome := rebuildMemoryOutcome{Code: engine.ErrorCode(refused)}
	if refused != nil && outcome.Code == "" {
		outcome.Code = refused.Error()
	}
	if _, err := narsil.Insert(ctx, callbackIndex, engine.NewDocument().Set("title", rebuildMemoryTitle(rebuildMemoryDocuments)),
		ruleID(rebuildMemoryDocuments), engine.InsertOptions{}); err != nil {
		return err
	}
	if outcome.Mismatch, err = rebuildMemoryMismatch(ctx, narsil); err != nil {
		return err
	}
	if err := narsil.Shutdown(ctx); err != nil {
		return err
	}
	return json.NewEncoder(out).Encode(outcome)
}

func requireRefusedForMemory(t *testing.T, room string, moment string) {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatalf("finding the test binary failed: %v", err)
	}
	bounded, cancel := context.WithTimeout(context.Background(), rebuildMemoryChildTimeout)
	defer cancel()
	child := exec.CommandContext(bounded, executable, "-test.run=^$")
	child.Env = append(os.Environ(), rebuildMemoryChildVariable+"="+room)
	var stderr bytes.Buffer
	child.Stderr = &stderr
	output, err := child.Output()
	if err != nil {
		t.Fatalf("the child failed: %v\n%s", err, stderr.String())
	}
	var outcome rebuildMemoryOutcome
	if err := json.Unmarshal(output, &outcome); err != nil {
		t.Fatalf("the child wrote %q, which is no outcome: %v", output, err)
	}
	if outcome.Code != engine.CodeAnalysisRebuildMemoryExceeded {
		t.Fatalf("the change on a heap %s returned %q, not %s", moment, outcome.Code,
			engine.CodeAnalysisRebuildMemoryExceeded)
	}
	if outcome.Mismatch != "" {
		t.Fatalf("after the refused change, %s", outcome.Mismatch)
	}
}

func TestAnAnalysisChangeWhoseSecondCopyOfTheTermsDoesNotFitIsRefusedBeforeItBuilds(t *testing.T) {
	t.Parallel()
	requireRefusedForMemory(t, rebuildMemoryRoomForHalfTheTerms, "without room for a second copy of its terms")
}

func TestAnAnalysisChangeIsRefusedWhenTheTokensKeptForWritesDuringItsBuildDoNotFit(t *testing.T) {
	t.Parallel()
	requireRefusedForMemory(t, rebuildMemoryRoomForTermsAlone,
		"with room for a second copy of its terms but not for the tokens that writes during the build keep")
}
