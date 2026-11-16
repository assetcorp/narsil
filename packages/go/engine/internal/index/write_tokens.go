package index

import (
	"context"

	"github.com/assetcorp/narsil/packages/go/engine/internal/callerctx"
	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/analysis"
)

type writeTokensKey struct{}

var _ = callerctx.EngineKey(writeTokensKey{})

func WithWriteTokens(ctx context.Context, tokens *analysis.Pass) context.Context {
	if tokens == nil {
		return ctx
	}
	return context.WithValue(ctx, writeTokensKey{}, tokens)
}

func WriteTokensOf(ctx context.Context) *analysis.Pass {
	tokens, _ := ctx.Value(writeTokensKey{}).(*analysis.Pass)
	return tokens
}

func (ix *Index) WriteTokens() (*analysis.Pass, error) {
	if !ix.settings.Analyzer.CallsCallerCode() {
		return nil, nil
	}
	prepared, err := ix.settings.Analyzer.Prepare()
	if err != nil {
		return nil, err
	}
	return prepared.Remembering(), nil
}

func (ix *Index) CallsCallerCode() bool {
	return ix.settings.Analyzer.CallsCallerCode()
}

func (ix *Index) KeepsTokensOf(tokens *analysis.Pass) bool {
	return tokens.Of(ix.settings.Analyzer)
}

func (ix *Index) MissingWriteTokens(ctx context.Context, tokens *analysis.Pass, kind WriteKind,
	writes []DocumentWrite) error {
	if !ix.KeepsTokensOf(tokens) {
		return nil
	}
	collecting := tokens.Collecting()
	if kind != WriteRemove {
		for _, write := range writes {
			values := write.ordered()
			if codec.DocumentFailure(values) != nil {
				continue
			}
			_ = ix.partitions[ix.partitionOf(write.ID)].Analyse(collecting, values)
		}
	}
	if kind != WriteInsert {
		if err := ix.collectStoredTokens(ctx, collecting, writes); err != nil {
			return err
		}
	}
	return analysis.MissedIn(collecting)
}

func (ix *Index) collectStoredTokens(ctx context.Context, collecting *analysis.Pass, writes []DocumentWrite) error {
	reading, err := ix.Read(ctx)
	if err != nil {
		return err
	}
	defer reading.Release()
	for _, write := range writes {
		target := ix.partitionOf(write.ID)
		stored, present, err := reading.Snapshots[target].Document(write.ID)
		if err != nil {
			return err
		}
		if !present {
			continue
		}
		_ = ix.partitions[target].Analyse(collecting, stored)
	}
	return nil
}

func keptWrite(tokens *analysis.Pass) *analysis.Pass {
	if tokens == nil {
		return nil
	}
	return tokens.KeptOnly()
}
