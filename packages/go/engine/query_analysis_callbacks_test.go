package engine_test

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const analysisCallbackChild = "NARSIL_ANALYSIS_CALLBACK_CHILD"

type reenteringTokenizer struct {
	armed atomic.Bool
	act   func()
}

func (c *reenteringTokenizer) Tokenize(text string) []engine.Token {
	if c.armed.Swap(false) {
		c.act()
	}
	words := strings.Fields(text)
	tokens := make([]engine.Token, len(words))
	for at, word := range words {
		tokens[at] = engine.Token{Token: strings.ToLower(word), Position: at}
	}
	return tokens
}

func TestQueryAnalysisCallbacksCanReplaceTheirIndex(t *testing.T) {
	if scenario := os.Getenv(analysisCallbackChild); scenario != "" {
		checkQueryAnalysisCallback(t, scenario)
		return
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, scenario := range []string{"query-close", "preflight-restore", "query-drop", "rerank-highlight-close", "worker-nested-query"} {
		t.Run(scenario, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			child := exec.CommandContext(ctx, executable, "-test.run=^TestQueryAnalysisCallbacksCanReplaceTheirIndex$")
			child.Env = append(os.Environ(), analysisCallbackChild+"="+scenario)
			if output, err := child.CombinedOutput(); err != nil {
				t.Fatalf("the callback failed or deadlocked: %v\n%s", err, output)
			}
		})
	}
}

func checkQueryAnalysisCallback(t *testing.T, scenario string) {
	ctx := context.Background()
	tokenizer := &reenteringTokenizer{}
	narsil, err := engine.New(ctx, engine.Config{
		Durability: &engine.DurabilityConfig{Directory: t.TempDir(), Mode: engine.DurabilitySync},
		Tokenizers: map[string]engine.Tokenizer{"callback": tokenizer},
		Workers: engine.WorkerConfig{Enabled: engine.Some(scenario == "worker-nested-query"), Count: engine.Some(1),
			PromotionThreshold: engine.Some(1), MainCopyQueries: engine.MainCopyQueriesNone},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer shutDown(t, narsil, "after the analysis callback")
	if err := narsil.CreateIndex(ctx, callbackIndex, engine.IndexConfig{
		Schema: engine.Schema{"title": engine.FieldString}, Tokenizer: engine.NamedTokenizer("callback"),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := narsil.Insert(ctx, callbackIndex, engine.NewDocument().Set("title", "lighthouse"), "kept", engine.InsertOptions{}); err != nil {
		t.Fatal(err)
	}
	archive := snapshotOf(t, narsil, callbackIndex)
	var callbackErr error
	tokenizer.act = func() {
		switch scenario {
		case "query-close", "rerank-highlight-close":
			callbackErr = narsil.Close(ctx, callbackIndex)
		case "preflight-restore":
			callbackErr = restoreArchive(narsil, callbackIndex, archive)
		case "query-drop":
			callbackErr = narsil.DropIndex(ctx, callbackIndex)
		case "worker-nested-query":
			_, callbackErr = narsil.Query(ctx, callbackIndex, engine.QueryParams{Term: "lighthouse"})
		}
	}
	params := engine.QueryParams{Term: "lighthouse"}
	if scenario == "rerank-highlight-close" {
		if err := narsil.RegisterRerankAdapter("callback", &callbackReranker{rerank: func(_ string, documents []string) ([]float64, error) {
			tokenizer.armed.Store(true)
			return []float64{1}, nil
		}}); err != nil {
			t.Fatal(err)
		}
		params.Rerank = &engine.RerankConfig{Adapter: "callback", Fields: []string{"title"}}
		params.Highlight = &engine.HighlightConfig{Fields: []string{"title"}}
	} else {
		tokenizer.armed.Store(true)
	}
	if scenario == "preflight-restore" {
		result, err := narsil.Preflight(ctx, callbackIndex, params)
		if err != nil || result.Count != 1 {
			t.Fatalf("preflight returned %+v, %v", result, err)
		}
	} else {
		result, err := narsil.Query(ctx, callbackIndex, params)
		if scenario == "query-drop" {
			if engine.ErrorCode(err) != engine.CodeIndexNotFound {
				t.Fatalf("query returned %v after the drop", err)
			}
		} else if err != nil || len(result.Hits) != 1 || result.Hits[0].ID != "kept" {
			t.Fatalf("query returned %+v, %v", result, err)
		}
	}
	if callbackErr != nil {
		t.Fatal(callbackErr)
	}
}
