package index

import (
	"context"

	"github.com/assetcorp/narsil/packages/go/engine/internal/callerctx"
	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/analysis"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partition"
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
	writes []DocumentWrite, previous *StoredRead) (*StoredRead, error) {
	if !ix.KeepsTokensOf(tokens) {
		return nil, nil
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
	read := previous
	if kind != WriteInsert && !ix.unchangedSince(ctx, previous) {
		var err error
		if read, err = ix.readStored(ctx, collecting, writes); err != nil {
			return nil, err
		}
	}
	return read, analysis.MissedIn(collecting)
}

func analyseWrittenValues(collecting *analysis.Pass, analysing *partition.Partition, writes []DocumentWrite) {
	for _, write := range writes {
		values := write.ordered()
		if codec.DocumentFailure(values) != nil {
			continue
		}
		_ = analysing.Analyse(collecting, values)
	}
}

func (ix *Index) MissingTokensBeside(ctx context.Context, tokens *analysis.Pass, writes []DocumentWrite) error {
	if !ix.KeepsTokensOf(tokens) || len(ix.partitions) == 0 {
		return nil
	}
	collecting := tokens.Collecting()
	analyseWrittenValues(collecting, ix.partitions[0], writes)
	if err := ix.collectStoredTokens(ctx, collecting, writes, nil); err != nil {
		return err
	}
	return analysis.MissedIn(collecting)
}

func (ix *Index) MissingTokensFrom(ctx context.Context, tokens *analysis.Pass, writes []DocumentWrite,
	source *Index) error {
	if !ix.KeepsTokensOf(tokens) || len(ix.partitions) == 0 {
		return nil
	}
	collecting := tokens.Collecting()
	analysing := ix.partitions[0]
	analyseWrittenValues(collecting, analysing, writes)
	if err := source.collectStoredTokensWith(ctx, collecting, writes, analysing); err != nil {
		return err
	}
	return analysis.MissedIn(collecting)
}

func (ix *Index) collectStoredTokensWith(ctx context.Context, collecting *analysis.Pass, writes []DocumentWrite,
	analysing *partition.Partition) error {
	reading, err := ix.Read(ctx)
	if err != nil {
		return err
	}
	defer reading.Release()
	for _, write := range writes {
		stored, present, err := reading.Snapshots[ix.partitionOf(write.ID)].Document(write.ID)
		if err != nil {
			return err
		}
		if present {
			_ = analysing.Analyse(collecting, stored)
		}
	}
	return nil
}

func (ix *Index) collectStoredTokens(ctx context.Context, collecting *analysis.Pass, writes []DocumentWrite,
	read *StoredRead) error {
	reading, err := ix.Read(ctx)
	if err != nil {
		return err
	}
	defer reading.Release()
	for _, write := range writes {
		target := ix.partitionOf(write.ID)
		encoded, stored, present, err := reading.Snapshots[target].CopiedDocument(write.ID)
		if err != nil {
			return err
		}
		if read != nil {
			read.present[write.ID] = present
			if present {
				read.documents[write.ID] = encoded
			}
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
