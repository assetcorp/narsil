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

func (commits *inFlightCommits) wait() {
	commits.mu.Lock()
	if commits.count == 0 {
		commits.mu.Unlock()
		return
	}
	if commits.drained == nil {
		commits.drained = make(chan struct{})
	}
	drained := commits.drained
	commits.mu.Unlock()
	<-drained
}

func (entry *indexEntry) lockWrites() {
	entry.writeMu.Lock()
	entry.commits.wait()
}

func (entry *indexEntry) unlockAndAwait(ctx context.Context, commit persist.Commit) error {
	entry.commits.begin()
	entry.writeMu.Unlock()
	outcome := commit.Await()
	entry.commits.end()
	return outcome.Settle(ctx)
}
