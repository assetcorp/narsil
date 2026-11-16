package engine

import (
	"context"
	"errors"
	"fmt"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/analysis"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist"
)

type lockedWrite func(ctx context.Context, entry *indexEntry) (persist.Commit, error)

func (n *Narsil) applyAndUnlock(ctx context.Context, entry *indexEntry, locked lockedWrite) error {
	commit, err := locked(ctx, entry)
	if awaited := entry.unlockAndAwait(ctx, commit); awaited != nil {
		err = awaited
	}
	return err
}

func (n *Narsil) applyKeepingTokens(ctx context.Context, name string, entry *indexEntry, release func(),
	kind index.WriteKind, writes []persist.Write, locked lockedWrite) (*indexEntry, func(), error) {
	if err := entry.writeMu.LockContext(ctx); err != nil {
		return entry, release, err
	}
	target, shadow := entry.index(), entry.shadowBuild()
	if !target.CallsCallerCode() && (shadow == nil || !shadow.CallsCallerCode()) {
		return entry, release, n.applyAndUnlock(ctx, entry, locked)
	}
	defer n.holdRetiredIndexes()()
	entry.writeMu.Unlock()
	release()
	documents := persist.DocumentWrites(writes)
	tokens, shadowTokens, storedRead, err := writeTokensOutside(ctx, target, shadow, kind, documents)
	changes := 0
	for {
		if err != nil {
			return nil, releasedNothing, err
		}
		if err = ctx.Err(); err != nil {
			continue
		}
		if entry, release, err = n.acquireContext(ctx, name); err != nil {
			return nil, releasedNothing, err
		}
		if err := entry.writeMu.LockContext(ctx); err != nil {
			return entry, release, err
		}
		if held := entry.index(); held != target {
			entry.writeMu.Unlock()
			release()
			if changes++; changes >= maxCallsAcrossIndexChanges {
				return nil, releasedNothing, indexReplacedDuringWriteAnalysis(name, changes)
			}
			target, shadow = held, entry.shadowBuild()
			tokens, shadowTokens, storedRead, err = writeTokensOutside(ctx, target, shadow, kind, documents)
			continue
		}
		var missed *analysis.MissedTokens
		storedRead, err = target.MissingWriteTokens(ctx, tokens, kind, documents, storedRead)
		if errors.As(err, &missed) {
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
		lockedCtx := index.WithStoredRead(index.WithWriteTokens(ctx, tokens), storedRead)
		commit, err := locked(withShadowTokens(lockedCtx, shadowTokens), entry)
		if awaited := entry.unlockAndAwait(ctx, commit); awaited != nil {
			err = awaited
		}
		if !errors.Is(err, analysis.ErrTokensNotKept) {
			return entry, release, err
		}
		release()
		err = nil
	}
}

func indexReplacedDuringWriteAnalysis(name string, changes int) error {
	return narsilerr.New(narsilerr.CodeWorkerBusy,
		fmt.Sprintf("Changes to index %q replaced it during each of %d analyses of this write", name, changes),
		map[string]any{"indexName": name, "analyses": changes})
}

func writeTokensOutside(ctx context.Context, target *index.Index, shadow *index.Index, kind index.WriteKind,
	documents []index.DocumentWrite) (*analysis.Pass, *analysis.Pass, *index.StoredRead, error) {
	if shadow == nil || !shadow.CallsCallerCode() {
		tokens, storedRead, err := tokensOutsideTheIndex(ctx, target, kind, documents)
		return tokens, nil, storedRead, err
	}
	shadowed := make(chan *analysis.Pass, 1)
	go func() { shadowed <- shadowTokensOutside(ctx, shadow, target, documents) }()
	tokens, storedRead, err := tokensOutsideTheIndex(ctx, target, kind, documents)
	return tokens, <-shadowed, storedRead, err
}

func tokensOutsideTheIndex(ctx context.Context, target *index.Index, kind index.WriteKind,
	documents []index.DocumentWrite) (*analysis.Pass, *index.StoredRead, error) {
	tokens, err := target.WriteTokens()
	if err != nil {
		return nil, nil, err
	}
	var missed *analysis.MissedTokens
	storedRead, err := target.MissingWriteTokens(ctx, tokens, kind, documents, nil)
	if errors.As(err, &missed) {
		tokens.Remember(missed.Sources)
	} else if err != nil {
		return nil, nil, err
	}
	return tokens, storedRead, nil
}
