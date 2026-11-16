package engine_test

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

func TestWritesRecheckTheirAnalysisAfterWaitingForACutover(t *testing.T) {
	if os.Getenv("NARSIL_WRITE_CUTOVER_CHILD") == "" {
		executable, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		child := exec.CommandContext(ctx, executable, "-test.run=^TestWritesRecheckTheirAnalysisAfterWaitingForACutover$", "-test.timeout=20s")
		child.Env = append(os.Environ(), "NARSIL_WRITE_CUTOVER_CHILD=1")
		if output, err := child.CombinedOutput(); err != nil {
			t.Fatalf("writes overlapping analysis switches failed or deadlocked: %v\n%s", err, output)
		}
		return
	}
	ctx := context.Background()
	var narsil *engine.Narsil
	nested := &nestedErrors{}
	tokenizer := splitTokenizer(func(text string) []engine.Token {
		if strings.HasPrefix(text, "written ") {
			err := narsil.Remove(ctx, callbackIndex, "absent", engine.WriteOptions{})
			if engine.ErrorCode(err) != engine.CodeDocNotFound {
				nested.note(fmt.Errorf("the nested removal returned %v", err))
			}
		}
		return lowercaseWords(text)
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
	const writers, updates, switches = 8, 100, 30
	for writer := range writers {
		if _, err := narsil.Insert(ctx, callbackIndex, engine.NewDocument().Set("title", "seed"),
			fmt.Sprintf("item-%d", writer), engine.InsertOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	var pending sync.WaitGroup
	for writer := range writers {
		pending.Go(func() {
			for update := range updates {
				title := fmt.Sprintf("written %d %d", writer, update)
				nested.note(narsil.Update(ctx, callbackIndex, fmt.Sprintf("item-%d", writer),
					engine.NewDocument().Set("title", title), engine.WriteOptions{}))
			}
		})
	}
	for change := range switches {
		tokenizer := engine.ChangeToRegisteredTokenizer("reentrant")
		if change%2 != 0 {
			tokenizer = engine.ResetTokenizer()
		}
		if err := narsil.ChangeAnalysis(ctx, callbackIndex, engine.AnalysisChange{Tokenizer: tokenizer}); err != nil {
			t.Fatal(err)
		}
	}
	pending.Wait()
	if err := nested.first(); err != nil {
		t.Fatal(err)
	}
	for writer := range writers {
		id := fmt.Sprintf("item-%d", writer)
		document, found, err := narsil.Get(ctx, callbackIndex, id)
		if err != nil || !found {
			t.Fatalf("the final document %s is missing: %v", id, err)
		}
		want := fmt.Sprintf("written %d %d", writer, updates-1)
		if value, _ := document.Get("title"); value != want {
			t.Fatalf("document %s holds %v, expected %s", id, value, want)
		}
	}
}
