package persist

import (
	"context"
	"sync"

	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/writeahead"
)

type appendedRecords struct {
	log    *partitionLog
	writer *writeahead.Writer
	seqNo  uint64
}

type Commit struct {
	durable       *Durable
	appended      []appendedRecords
	applied       int
	documentBytes int64
	stalls        bool
}

type CommitOutcome struct {
	commit   Commit
	failedAt int
	err      error
}

func (commit Commit) waits() bool {
	durable := commit.durable
	return durable != nil && len(commit.appended) > 0 && durable.manager.logged() &&
		durable.manager.settings.Mode == ModeSync
}

func (commit Commit) Await() CommitOutcome {
	if !commit.waits() {
		return CommitOutcome{commit: commit}
	}
	errs := make([]error, len(commit.appended))
	if len(commit.appended) == 1 {
		errs[0] = commit.appended[0].writer.CommitThrough(commit.appended[0].seqNo)
	} else {
		var waiting sync.WaitGroup
		for at, records := range commit.appended {
			waiting.Go(func() { errs[at] = records.writer.CommitThrough(records.seqNo) })
		}
		waiting.Wait()
	}
	for at, err := range errs {
		if err != nil {
			return CommitOutcome{commit: commit, failedAt: at, err: err}
		}
	}
	return CommitOutcome{commit: commit}
}

func (outcome CommitOutcome) Settle(ctx context.Context) error {
	commit := outcome.commit
	durable := commit.durable
	if durable == nil {
		return nil
	}
	if outcome.err != nil {
		log := commit.appended[outcome.failedAt].log
		log.mutex.Lock()
		failure := durable.failPartition(log, outcome.err)
		log.mutex.Unlock()
		return failure
	}
	if commit.waits() {
		if err := durable.manager.verifyDirectory(); err != nil {
			return err
		}
	}
	durable.noteRecorded(commit.applied, commit.documentBytes)
	if commit.stalls {
		durable.stallWhileCheckpointsFallBehind(ctx)
	}
	return nil
}
