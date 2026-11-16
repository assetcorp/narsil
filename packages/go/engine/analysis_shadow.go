package engine

import (
	"context"
	"errors"

	"github.com/assetcorp/narsil/packages/go/engine/internal/callerctx"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/analysis"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist"
)

type shadowTokensKey struct{}

var _ = callerctx.EngineKey(shadowTokensKey{})

func withShadowTokens(ctx context.Context, tokens *analysis.Pass) context.Context {
	if tokens == nil {
		return ctx
	}
	return context.WithValue(ctx, shadowTokensKey{}, tokens)
}

func shadowTokensOf(ctx context.Context) *analysis.Pass {
	tokens, _ := ctx.Value(shadowTokensKey{}).(*analysis.Pass)
	return tokens
}

func shadowPassOf(shadow *index.Index) *analysis.Pass {
	if shadow == nil || !shadow.CallsCallerCode() {
		return nil
	}
	tokens, err := shadow.WriteTokens()
	if err != nil {
		return nil
	}
	return tokens
}

func newRebuildLog(shadow *index.Index, tokens *analysis.Pass) *rebuildLog {
	return &rebuildLog{ids: map[string]struct{}{}, shadow: shadow, tokens: tokens}
}

func (log *rebuildLog) keep(tokens *analysis.Pass, documents int) {
	if log.tokens == nil || tokens == nil || log.kept >= rebuildKeptTokenDocuments {
		return
	}
	log.tokens.Absorb(tokens)
	log.kept += documents
}

func (entry *indexEntry) shadowBuild() *index.Index {
	entry.swap.mu.Lock()
	defer entry.swap.mu.Unlock()
	if entry.swap.log == nil {
		return nil
	}
	return entry.swap.log.shadow
}

func shadowTokensOutside(ctx context.Context, shadow *index.Index, live *index.Index,
	documents []index.DocumentWrite) *analysis.Pass {
	tokens := shadowPassOf(shadow)
	if tokens == nil {
		return nil
	}
	var missed *analysis.MissedTokens
	if err := shadow.MissingTokensFrom(ctx, tokens, documents, live); errors.As(err, &missed) {
		tokens.Remember(missed.Sources)
	} else if err != nil {
		return nil
	}
	return tokens
}

func (entry *indexEntry) peekLogged() ([]string, bool, *analysis.Pass) {
	entry.swap.mu.Lock()
	defer entry.swap.mu.Unlock()
	log := entry.swap.log
	if log == nil {
		return nil, false, nil
	}
	ids := make([]string, 0, len(log.ids))
	for id := range log.ids {
		ids = append(ids, id)
	}
	return ids, log.cleared, log.tokens
}

func (entry *indexEntry) takeLogged() ([]string, bool, *analysis.Pass) {
	entry.swap.mu.Lock()
	defer entry.swap.mu.Unlock()
	log := entry.swap.log
	if log == nil {
		return nil, false, nil
	}
	ids := make([]string, 0, len(log.ids))
	for id := range log.ids {
		ids = append(ids, id)
	}
	entry.swap.log = newRebuildLog(log.shadow, log.tokens.Fresh())
	return ids, log.cleared, log.tokens
}

func (entry *indexEntry) rememberLogged(sources []string) {
	entry.swap.mu.Lock()
	log := entry.swap.log
	var tokens *analysis.Pass
	if log != nil {
		tokens = log.tokens
	}
	entry.swap.mu.Unlock()
	if tokens != nil {
		tokens.Remember(sources)
	}
}

func liveWrites(ctx context.Context, live *index.Index, ids []string) ([]persist.Write, error) {
	writes := make([]persist.Write, len(ids))
	for at, id := range ids {
		write, _, err := storedWrite(ctx, live, id)
		if err != nil {
			return nil, err
		}
		writes[at] = write
	}
	return writes, nil
}

func refusedTokens(err error, failures []error) bool {
	if errors.Is(err, analysis.ErrTokensNotKept) {
		return true
	}
	for _, failure := range failures {
		if errors.Is(failure, analysis.ErrTokensNotKept) {
			return true
		}
	}
	return false
}

func firstDocumentFailure(writes []persist.Write, failures []error) error {
	for at, failure := range failures {
		if failure != nil && writes[at].Document != nil {
			return failure
		}
	}
	return nil
}

func keptShadowApply(ctx context.Context, handle *persist.Handle, side *index.Index, writes []persist.Write,
	tokens *analysis.Pass) (bool, error) {
	if tokens == nil && side.CallsCallerCode() {
		tokens = shadowPassOf(side)
	}
	if tokens != nil {
		if err := side.MissingTokensBeside(ctx, tokens, persist.DocumentWrites(writes)); err != nil {
			return false, err
		}
	}
	failures, err := handle.ApplyTo(index.WithWriteTokens(ctx, tokens), side, writes, false)
	if refusedTokens(err, failures) {
		return false, analysis.ErrTokensNotKept
	}
	if err != nil {
		return false, err
	}
	return true, firstDocumentFailure(writes, failures)
}

func (entry *indexEntry) applyToShadow(ctx context.Context, side *index.Index, writes []persist.Write,
	tokens *analysis.Pass) error {
	if tokens == nil && side.CallsCallerCode() {
		tokens = shadowPassOf(side)
	}
	for round := 1; ; round++ {
		applied, err := keptShadowApply(ctx, entry.handle, side, writes, tokens)
		if applied || round >= shadowTokenRounds {
			if !applied && errors.Is(err, analysis.ErrTokensNotKept) {
				failures, applyErr := entry.handle.ApplyTo(ctx, side, writes, false)
				if applyErr != nil {
					return applyErr
				}
				return firstDocumentFailure(writes, failures)
			}
			return err
		}
		var missed *analysis.MissedTokens
		switch {
		case errors.As(err, &missed):
			tokens.Remember(missed.Sources)
		case errors.Is(err, analysis.ErrTokensNotKept):
		default:
			return err
		}
	}
}

func (entry *indexEntry) takeLiveWrites(ctx context.Context) ([]persist.Write, bool, *analysis.Pass, error) {
	entry.lockWrites()
	defer entry.writeMu.Unlock()
	ids, cleared, tokens := entry.takeLogged()
	if len(ids) == 0 {
		return nil, cleared, tokens, nil
	}
	writes, err := liveWrites(ctx, entry.index(), ids)
	return writes, cleared, tokens, err
}

func (entry *indexEntry) catchUpRound(ctx context.Context, side *index.Index) error {
	writes, cleared, tokens, err := entry.takeLiveWrites(ctx)
	if err != nil {
		return err
	}
	if cleared {
		if err := side.Clear(nil); err != nil {
			return err
		}
	}
	if len(writes) == 0 {
		return nil
	}
	return entry.applyToShadow(ctx, side, writes, tokens)
}

func (entry *indexEntry) catchUp(ctx context.Context, side *index.Index, proceed func() error) error {
	for entry.loggedCount() > rebuildSwitchBacklogDocuments {
		if err := proceed(); err != nil {
			return err
		}
		if err := entry.catchUpRound(ctx, side); err != nil {
			return err
		}
	}
	return nil
}

func (entry *indexEntry) cutoverWrites(ctx context.Context, side *index.Index) error {
	ids, cleared, tokens := entry.peekLogged()
	if cleared {
		if err := side.Clear(nil); err != nil {
			return err
		}
	}
	if len(ids) == 0 {
		return nil
	}
	writes, err := liveWrites(ctx, entry.index(), ids)
	if err != nil {
		return err
	}
	if tokens == nil && side.CallsCallerCode() {
		return analysis.ErrTokensNotKept
	}
	_, err = keptShadowApply(ctx, entry.handle, side, writes, tokens)
	return err
}
