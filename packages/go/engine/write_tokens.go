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
	target, shadow := entry.index(), entry.shadowBuild()
	if !target.CallsCallerCode() && (shadow == nil || !shadow.CallsCallerCode()) {
		return entry, release, n.applyLocked(ctx, entry, locked)
	}
	release()
	documents, kind := persist.DocumentWrites(writes), writeKindOf(writes)
	tokens, shadowTokens, err := writeTokensOutside(ctx, target, shadow, kind, documents)
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
			target, shadow = held, entry.shadowBuild()
			tokens, shadowTokens, err = writeTokensOutside(ctx, target, shadow, kind, documents)
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
		commit, err := locked(withShadowTokens(index.WithWriteTokens(ctx, tokens), shadowTokens), entry)
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

func writeTokensOutside(ctx context.Context, target *index.Index, shadow *index.Index, kind index.WriteKind,
	documents []index.DocumentWrite) (*analysis.Pass, *analysis.Pass, error) {
	if shadow == nil || !shadow.CallsCallerCode() {
		tokens, err := tokensOutsideTheIndex(ctx, target, kind, documents)
		return tokens, nil, err
	}
	shadowed := make(chan *analysis.Pass, 1)
	go func() { shadowed <- shadowTokensOutside(ctx, shadow, target, documents) }()
	tokens, err := tokensOutsideTheIndex(ctx, target, kind, documents)
	return tokens, <-shadowed, err
}

func tokensOutsideTheIndex(ctx context.Context, target *index.Index, kind index.WriteKind,
	documents []index.DocumentWrite) (*analysis.Pass, error) {
	tokens, err := target.WriteTokens()
	if err != nil {
		return nil, err
	}
	var missed *analysis.MissedTokens
	if err := target.MissingWriteTokens(ctx, tokens, kind, documents); errors.As(err, &missed) {
		tokens.Remember(missed.Sources)
	} else if err != nil {
		return nil, err
	}
	return tokens, nil
}
