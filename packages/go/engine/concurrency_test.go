package engine_test

import (
	"bytes"
	"context"
	"fmt"
	"math/rand"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	mixedStepsPerOwner           = 800
	mixedReaders                 = 4
	mixedOwnerStepsPerChaosRound = 16
	mixedReaderPause             = time.Millisecond
	mixedInsertBatch             = 12
	mixedRemoveEvery             = 4
	mixedChaosRestart            = 0
	mixedChaosSnapshot           = 1
	mixedChaosRestore            = 2
	mixedChaosKindCount          = 3
)

type mixedRun struct {
	ctx        context.Context
	directory  string
	gate       sync.RWMutex
	narsil     *engine.Narsil
	owners     []*mixedOwner
	versions   [][]int
	promotions atomic.Int64
	failure    atomic.Pointer[error]
	snapshot   []byte
	snapshotOf []map[string]mixedDocument
	ownerSteps atomic.Int64
	chaosDue   chan struct{}
}

func (run *mixedRun) recordOwnerStep() {
	if run.ownerSteps.Add(1)%mixedOwnerStepsPerChaosRound != 0 {
		return
	}
	select {
	case run.chaosDue <- struct{}{}:
	default:
	}
}

func (run *mixedRun) awaitChaosRound(round int, stop <-chan struct{}) bool {
	for run.ownerSteps.Load() < int64(round+1)*mixedOwnerStepsPerChaosRound {
		select {
		case <-stop:
			return false
		case <-run.chaosDue:
		}
	}
	return true
}

func (run *mixedRun) fail(err error) {
	if err != nil {
		run.failure.CompareAndSwap(nil, &err)
	}
}

func (run *mixedRun) failed() bool {
	return run.failure.Load() != nil
}

func (run *mixedRun) open() error {
	narsil, err := engine.New(run.ctx, engine.Config{
		Durability: &engine.DurabilityConfig{Directory: run.directory, Mode: engine.DurabilitySync},
		Events:     engine.EventHandlers{WorkerPromote: func(engine.WorkerPromoteEvent) { run.promotions.Add(1) }},
	})
	if err != nil {
		return err
	}
	run.narsil = narsil
	if len(narsil.ListIndexes()) == 0 {
		return narsil.CreateIndex(run.ctx, mixedIndexName, mixedSchema())
	}
	return nil
}

func (run *mixedRun) ownerStep(position int, random *rand.Rand) error {
	run.gate.RLock()
	defer run.gate.RUnlock()
	owner := run.owners[position]
	owner.mu.Lock()
	defer owner.mu.Unlock()
	slot := random.Intn(mixedSlotsPerOwner)
	id := mixedID(position, slot)
	run.versions[position][slot]++
	version := run.versions[position][slot]
	if _, live := owner.live[id]; live {
		if random.Intn(mixedRemoveEvery) == 0 {
			if err := run.narsil.Remove(run.ctx, mixedIndexName, id, engine.WriteOptions{}); err != nil {
				return fmt.Errorf("removing %s failed: %w", id, err)
			}
			delete(owner.live, id)
		} else {
			fields, held := mixedFields(owner.token, slot, version)
			if err := run.narsil.Update(run.ctx, mixedIndexName, id, fields, engine.WriteOptions{}); err != nil {
				return fmt.Errorf("updating %s failed: %w", id, err)
			}
			owner.live[id] = held
		}
	} else {
		batch := []*engine.Document{}
		staged := map[string]mixedDocument{}
		for offset := 0; offset < mixedSlotsPerOwner && len(batch) < mixedInsertBatch; offset++ {
			candidate := (slot + offset) % mixedSlotsPerOwner
			candidateID := mixedID(position, candidate)
			if _, live := owner.live[candidateID]; live {
				continue
			}
			fields, held := mixedFields(owner.token, candidate, version)
			batch = append(batch, fields.Set("id", candidateID))
			staged[candidateID] = held
		}
		result, err := run.narsil.InsertBatch(run.ctx, mixedIndexName, batch, engine.InsertOptions{})
		if err != nil || len(result.Failed) > 0 {
			return fmt.Errorf("inserting %d documents failed: %v %+v", len(batch), err, result.Failed)
		}
		for stagedID, held := range staged {
			owner.live[stagedID] = held
		}
	}
	return checkOwnerAnswers(run.ctx, run.narsil, owner, mixedVector(slot, version))
}

func (run *mixedRun) readerStep(random *rand.Rand) error {
	run.gate.RLock()
	defer run.gate.RUnlock()
	position := random.Intn(len(run.owners))
	owner := run.owners[position]
	owner.mu.Lock()
	defer owner.mu.Unlock()
	return checkOwnerAnswers(run.ctx, run.narsil, owner, mixedVector(random.Intn(mixedSlotsPerOwner), position))
}

func (run *mixedRun) chaosStep(kind int) error {
	run.gate.Lock()
	defer run.gate.Unlock()
	switch kind {
	case mixedChaosRestart:
		if err := run.narsil.Shutdown(run.ctx); err != nil {
			return fmt.Errorf("shutting down for a restart failed: %w", err)
		}
		if err := run.open(); err != nil {
			return fmt.Errorf("reopening after a restart failed: %w", err)
		}
	case mixedChaosSnapshot:
		var buffer bytes.Buffer
		if err := run.narsil.Snapshot(run.ctx, mixedIndexName, engine.SnapshotOptions{}, &buffer); err != nil {
			return fmt.Errorf("taking a snapshot failed: %w", err)
		}
		run.snapshot = buffer.Bytes()
		run.snapshotOf = copyOwnerStates(run.owners)
	case mixedChaosRestore:
		if run.snapshot == nil {
			return nil
		}
		if err := run.narsil.Restore(run.ctx, mixedIndexName, bytes.NewReader(run.snapshot)); err != nil {
			return fmt.Errorf("restoring a snapshot failed: %w", err)
		}
		for position, owner := range run.owners {
			owner.live = map[string]mixedDocument{}
			for id, held := range run.snapshotOf[position] {
				owner.live[id] = held
			}
		}
	}
	return checkEveryOwner(run.ctx, run.narsil, run.owners)
}

func TestConcurrentWritesRestartsAndRestoresKeepEverySearchExact(t *testing.T) {
	t.Parallel()
	run := &mixedRun{ctx: context.Background(), directory: t.TempDir(), chaosDue: make(chan struct{}, 1)}
	for _, token := range mixedOwnerTokens {
		run.owners = append(run.owners, &mixedOwner{token: token, live: map[string]mixedDocument{}})
		run.versions = append(run.versions, make([]int, mixedSlotsPerOwner))
	}
	if err := run.open(); err != nil {
		t.Fatalf("the engine refused to open: %v", err)
	}
	defer func() { _ = run.narsil.Shutdown(context.Background()) }()
	var writers, background sync.WaitGroup
	stop := make(chan struct{})
	for position := range run.owners {
		writers.Add(1)
		go func(position int) {
			defer writers.Done()
			random := rand.New(rand.NewSource(int64(1_000 + position)))
			for step := 0; step < mixedStepsPerOwner && !run.failed(); step++ {
				run.fail(run.ownerStep(position, random))
				run.recordOwnerStep()
			}
		}(position)
	}
	for reader := range mixedReaders {
		background.Add(1)
		go func(reader int) {
			defer background.Done()
			random := rand.New(rand.NewSource(int64(2_000 + reader)))
			for !run.failed() {
				select {
				case <-stop:
					return
				case <-time.After(mixedReaderPause):
				}
				run.fail(run.readerStep(random))
			}
		}(reader)
	}
	background.Add(1)
	go func() {
		defer background.Done()
		for round := 0; !run.failed(); round++ {
			if !run.awaitChaosRound(round, stop) {
				return
			}
			run.fail(run.chaosStep(round % mixedChaosKindCount))
		}
	}()
	writers.Wait()
	close(stop)
	background.Wait()
	if failure := run.failure.Load(); failure != nil {
		t.Fatalf("a search disagreed with the oracle or an operation failed: %s: %v", codeOrMessage(*failure), *failure)
	}
	if err := run.chaosStep(mixedChaosRestart); err != nil {
		t.Fatalf("the final restart disagreed with the oracle: %v", err)
	}
	if run.promotions.Load() == 0 {
		t.Fatal("the index never promoted to worker copies, so the run never searched through them")
	}
}
