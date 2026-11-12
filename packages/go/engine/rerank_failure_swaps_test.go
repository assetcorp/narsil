package engine_test

import (
	"context"
	"errors"
	"math"
	"sync/atomic"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const failureSwapTimeout = 5 * time.Second

type failingSwapReranker struct {
	change   func() error
	answer   func(context.Context, int) ([]float64, error)
	calls    atomic.Int32
	changed  chan error
	finished chan struct{}
}

func (r *failingSwapReranker) Rerank(ctx context.Context, _ string, documents []string) ([]float64, error) {
	if r.calls.Add(1) != 1 {
		return make([]float64, len(documents)), nil
	}
	defer close(r.finished)
	err := r.change()
	r.changed <- err
	if err != nil {
		return nil, err
	}
	return r.answer(ctx, len(documents))
}

func TestARerankFailureRemainsVisibleAfterTheCallbackChangesTheIndex(t *testing.T) {
	archive := archiveOfTrails(t, trailConfig(""), nil)
	changes := []struct {
		name   string
		change func(*engine.Narsil) error
	}{
		{"unchanged", func(*engine.Narsil) error { return nil }},
		{"restore", func(n *engine.Narsil) error { return restoreArchive(n, trailIndex, archive) }},
		{"analysis", func(n *engine.Narsil) error {
			return n.ChangeAnalysis(context.Background(), trailIndex,
				engine.AnalysisChange{StopWords: engine.ChangeToStopWordList("meadow")})
		}},
		{"rebalance", rebalanceToTheOtherCount},
	}
	answers := []struct {
		name   string
		answer func(context.Context, int) ([]float64, error)
	}{
		{"error", func(context.Context, int) ([]float64, error) { return nil, errors.New("adapter refused") }},
		{"panic", func(context.Context, int) ([]float64, error) { panic("adapter panicked") }},
		{"nil", func(context.Context, int) ([]float64, error) { return nil, nil }},
		{"empty", func(context.Context, int) ([]float64, error) { return []float64{}, nil }},
		{"short", func(_ context.Context, count int) ([]float64, error) { return make([]float64, count-1), nil }},
		{"long", func(_ context.Context, count int) ([]float64, error) { return make([]float64, count+1), nil }},
		{"nan", func(_ context.Context, count int) ([]float64, error) {
			scores := make([]float64, count)
			scores[0] = math.NaN()
			return scores, nil
		}},
		{"infinity", func(_ context.Context, count int) ([]float64, error) {
			scores := make([]float64, count)
			scores[0] = math.Inf(1)
			return scores, nil
		}},
		{"negative infinity", func(_ context.Context, count int) ([]float64, error) {
			scores := make([]float64, count)
			scores[0] = math.Inf(-1)
			return scores, nil
		}},
		{"timeout", func(ctx context.Context, _ int) ([]float64, error) {
			<-ctx.Done()
			return nil, ctx.Err()
		}},
	}
	for _, change := range changes {
		for _, answer := range answers {
			t.Run(change.name+"/"+answer.name, func(t *testing.T) {
				t.Parallel()
				ctx := context.Background()
				directory := t.TempDir()
				narsil, err := engine.New(ctx, engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)},
					RerankTimeout: engine.Some(failureSwapTimeout),
					Durability:    &engine.DurabilityConfig{Directory: directory, Mode: engine.DurabilitySync}})
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = narsil.Shutdown(ctx) })
				config := trailConfig("")
				config.Partitions = engine.PartitionConfig{MaxPartitions: engine.Some(moreSwappedPartitions)}
				fillTrails(t, narsil, config, restoredTrails)
				reranker := &failingSwapReranker{change: func() error { return change.change(narsil) },
					answer: answer.answer, changed: make(chan error, 1), finished: make(chan struct{})}
				if err := narsil.RegisterRerankAdapter(restoringRerankAdapter, reranker); err != nil {
					t.Fatal(err)
				}
				_, err = narsil.Query(ctx, trailIndex, rerankedTrailSearch())
				<-reranker.finished
				if changeErr := <-reranker.changed; changeErr != nil {
					t.Fatalf("the callback could not change the index: %v", changeErr)
				}
				if engine.ErrorCode(err) != engine.CodeRerankFailed {
					t.Fatalf("the query returned %s, expected %s: %v", codeOrMessage(err), engine.CodeRerankFailed, err)
				}
				if calls := reranker.calls.Load(); calls != 1 {
					t.Fatalf("the failed adapter received %d calls, expected 1", calls)
				}
				if err := narsil.Shutdown(ctx); err != nil {
					t.Fatal(err)
				}
				restarted := openFilesEngine(t, directory)
				t.Cleanup(func() { _ = restarted.Shutdown(ctx) })
				params := rerankedTrailSearch()
				params.Rerank = nil
				page, err := restarted.Query(ctx, trailIndex, params)
				if err != nil || page.Count != 4 {
					t.Fatalf("the restarted index counted %d trails, expected 4: %v", page.Count, err)
				}
			})
		}
	}
}
