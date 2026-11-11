package engine

import (
	"context"
	"fmt"
	"math"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type rerankSettings struct {
	timeout   time.Duration
	maxWindow int
}

func resolveRerankSettings(config model.Config) (rerankSettings, error) {
	settings := rerankSettings{timeout: defaultRerankTimeout, maxWindow: defaultMaxRerankWindow}
	if timeout, set := config.RerankTimeout.Get(); set {
		if timeout < minRerankTimeout || timeout > maxRerankTimeout || timeout%time.Millisecond != 0 {
			return rerankSettings{}, narsilerr.New(narsilerr.CodeConfigInvalid,
				fmt.Sprintf("rerankTimeout must be a whole number of milliseconds from %d to %d",
					minRerankTimeout.Milliseconds(), maxRerankTimeout.Milliseconds()),
				map[string]any{"rerankTimeout": timeout.Milliseconds()})
		}
		settings.timeout = timeout
	}
	if window, set := config.MaxRerankWindow.Get(); set {
		if window < minRerankWindow || window > maxRerankWindow {
			return rerankSettings{}, narsilerr.New(narsilerr.CodeConfigInvalid,
				fmt.Sprintf("maxRerankWindow must be a whole number from %d to %d", minRerankWindow, maxRerankWindow),
				map[string]any{"maxRerankWindow": window})
		}
		settings.maxWindow = window
	}
	return settings, nil
}

func rerankFailed(message, adapter string, details map[string]any) error {
	if details == nil {
		details = map[string]any{}
	}
	details["adapter"] = adapter
	return narsilerr.New(narsilerr.CodeRerankFailed, message, details)
}

func checkedRerankScores(raw []float64, expected int, name string) ([]float64, error) {
	if raw == nil {
		return nil, rerankFailed(fmt.Sprintf("Rerank adapter %q returned nothing, expected a list of scores", name), name, nil)
	}
	if len(raw) != expected {
		return nil, rerankFailed(fmt.Sprintf("Rerank adapter %q returned %d scores for %d documents", name, len(raw), expected),
			name, map[string]any{"expected": expected, "actual": len(raw)})
	}
	for at, score := range raw {
		if math.IsNaN(score) || math.IsInf(score, 0) {
			return nil, rerankFailed(fmt.Sprintf("Rerank adapter %q returned a score that is not a finite number at position %d", name, at),
				name, map[string]any{"position": at})
		}
	}
	return append([]float64(nil), raw...), nil
}

func wrappedRerankFailure(err error, name string) error {
	if code := narsilerr.CodeOf(err); code == narsilerr.CodeRerankFailed {
		return err
	}
	details := map[string]any{"cause": err.Error()}
	if code := narsilerr.CodeOf(err); code != "" {
		details["causeCode"] = code
	}
	return rerankFailed(fmt.Sprintf("Rerank adapter %q failed: %s", name, err.Error()), name, details)
}

type rerankAnswer struct {
	scores []float64
	err    error
}

func callRerankAdapter(ctx context.Context, adapter model.RerankAdapter, name, query string, documents []string) rerankAnswer {
	answer := rerankAnswer{}
	func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				answer.err = fmt.Errorf("%v", recovered)
			}
		}()
		answer.scores, answer.err = adapter.Rerank(ctx, query, append([]string(nil), documents...))
	}()
	return answer
}

func (n *Narsil) rerankScorer(ctx context.Context, name, query string, documents []string) ([]float64, error) {
	adapter, found := n.adapters.reranker(name)
	if !found {
		return nil, narsilerr.New(narsilerr.CodeRerankConfigInvalid,
			fmt.Sprintf("The query gives rerank adapter %q, which this engine has not registered. Register it with RegisterRerankAdapter or the RerankAdapters setting", name),
			map[string]any{"adapter": name, "registered": n.adapters.rerankerNames()})
	}
	if len(documents) == 0 {
		return []float64{}, nil
	}
	if n.stopping.Err() != nil {
		return nil, rerankFailed(fmt.Sprintf("The engine cancelled the call to rerank adapter %q", name), name, nil)
	}
	timeout := n.rerank.timeout
	call, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	stopWatch := context.AfterFunc(n.stopping, cancel)
	defer stopWatch()
	answered := make(chan rerankAnswer, 1)
	go func() { answered <- callRerankAdapter(call, adapter, name, query, documents) }()
	select {
	case answer := <-answered:
		if answer.err != nil {
			return nil, wrappedRerankFailure(answer.err, name)
		}
		return checkedRerankScores(answer.scores, len(documents), name)
	case <-call.Done():
		if n.stopping.Err() != nil {
			return nil, rerankFailed(fmt.Sprintf("The engine cancelled the call to rerank adapter %q", name), name, nil)
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		return nil, rerankFailed(fmt.Sprintf("Rerank adapter %q did not answer within %d ms, so the engine cancelled the call", name, timeout.Milliseconds()),
			name, map[string]any{"timeoutMs": timeout.Milliseconds()})
	}
}
