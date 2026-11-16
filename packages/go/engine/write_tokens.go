package engine

import (
	"context"
	"errors"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/analysis"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist"
)

type lockedWrite func(ctx context.Context, entry *indexEntry) (persist.Commit, error)

func writeKindOf(writes []persist.Write) index.WriteKind {
	for _, write := range writes {
		if write.Document != nil || write.Encoded != nil {
			return index.WriteUpdate
		}
	}
	return index.WriteRemove
}

func (n *Narsil) applyLocked(ctx context.Context, entry *indexEntry, locked lockedWrite) error {
	entry.writeMu.Lock()
	commit, err := locked(ctx, entry)
	if awaited := entry.unlockAndAwait(ctx, commit); err == nil {
		err = awaited
	}
	return err
}

func (n *Narsil) applyKeepingTokens(ctx context.Context, name string, entry *indexEntry, release func(),
	writes []persist.Write, locked lockedWrite) (*indexEntry, func(), error) {
	target := entry.index()
	if !target.CallsCallerCode() {
		return entry, release, n.applyLocked(ctx, entry, locked)
	}
	release()
	documents, kind := persist.DocumentWrites(writes), writeKindOf(writes)
	tokens, err := tokensOutsideTheIndex(target, documents)
	changes := 0
	for {
		if err != nil {
			return nil, releasedNothing, err
		}
		if err = ctx.Err(); err != nil {
			continue
		}
		if entry, release, err = n.acquire(name); err != nil {
			return nil, releasedNothing, err
		}
		if held := entry.index(); held != target {
			release()
			if changes++; changes >= maxCallsAcrossIndexChanges {
				return nil, releasedNothing, indexReplacedDuringAnalysis(name, changes)
			}
			target = held
			tokens, err = tokensOutsideTheIndex(target, documents)
			continue
		}
		entry.writeMu.Lock()
		var missed *analysis.MissedTokens
		if err = target.MissingWriteTokens(ctx, tokens, kind, documents); errors.As(err, &missed) {
			entry.writeMu.Unlock()
			release()
			tokens.Remember(missed.Sources)
			err = nil
			continue
		}
		if err != nil {
			entry.writeMu.Unlock()
			return entry, release, err
		}
		commit, err := locked(index.WithWriteTokens(ctx, tokens), entry)
		if awaited := entry.unlockAndAwait(ctx, commit); err == nil {
			err = awaited
		}
		if !errors.Is(err, analysis.ErrTokensNotKept) {
			return entry, release, err
		}
		release()
		err = nil
	}
}

func tokensOutsideTheIndex(target *index.Index, documents []index.DocumentWrite) (*analysis.Pass, error) {
	tokens, err := target.WriteTokens()
	if err != nil {
		return nil, err
	}
	var missed *analysis.MissedTokens
	if err := target.MissingWriteTokens(context.Background(), tokens, index.WriteInsert, documents); errors.As(err,
		&missed) {
		tokens.Remember(missed.Sources)
	} else if err != nil {
		return nil, err
	}
	return tokens, nil
}
