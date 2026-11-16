package engine

import (
	"context"
	"sync"

	"github.com/assetcorp/narsil/packages/go/engine/internal/persist"
)

type inFlightCommits struct {
	mu      sync.Mutex
	count   int
	drained chan struct{}
}

func (commits *inFlightCommits) begin() {
	commits.mu.Lock()
	commits.count++
	commits.mu.Unlock()
}

func (commits *inFlightCommits) end() {
	commits.mu.Lock()
	defer commits.mu.Unlock()
	commits.count--
	if commits.count == 0 && commits.drained != nil {
		close(commits.drained)
		commits.drained = nil
	}
}

func (commits *inFlightCommits) wait(ctx context.Context) error {
	commits.mu.Lock()
	if commits.count == 0 {
		commits.mu.Unlock()
		return ctx.Err()
	}
	if commits.drained == nil {
		commits.drained = make(chan struct{})
	}
	drained := commits.drained
	commits.mu.Unlock()
	select {
	case <-drained:
		return ctx.Err()
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (entry *indexEntry) lockWrites() {
	_ = entry.lockWritesContext(context.Background())
}

func (entry *indexEntry) lockWritesContext(ctx context.Context) error {
	if err := entry.writeMu.LockContext(ctx); err != nil {
		return err
	}
	if err := entry.commits.wait(ctx); err != nil {
		entry.writeMu.Unlock()
		return err
	}
	return nil
}

func (entry *indexEntry) unlockAndAwait(ctx context.Context, commit persist.Commit) error {
	entry.commits.begin()
	entry.writeMu.Unlock()
	outcome := commit.Await()
	entry.commits.end()
	return outcome.Settle(ctx)
}
