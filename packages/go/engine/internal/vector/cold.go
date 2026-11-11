package vector

import (
	"context"
	"maps"
	"sync"
	"sync/atomic"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
)

type ColdVectorField interface {
	LiveCount() int
	ResidentBytes() int
	NumberOf(docID string) (int, bool, error)
	VectorOfNumber(number int) ([]float32, error)
	PartitionOf(ctx context.Context, docID string) (int32, bool, error)
	FilePaths() []string
	AcceptedNumbers(ctx context.Context, filter *Filter) ([]uint32, error)
	Search(ctx context.Context, query []float32, k int, options SearchOptions, accepted []uint32,
		excluded map[int]struct{}) ([]ScoredResult, error)
	ScoreNumbers(query []float32, metric core.Metric, numbers []int, distances []float64) error
	Close()
}

type ColdFieldLoad func(ctx context.Context, beginRestore func(shape CheckpointRestoreShape) (*CheckpointRestore, error),
	stillWanted func() bool, loadingWanted <-chan struct{}) error

type coldView struct {
	written        map[string]int32
	removedNumbers map[int]struct{}
	removedIDs     map[string]struct{}
	live           int
	sequence       int64
	committed      int64
	earlier        atomic.Pointer[coldView]
}

type coldHold struct {
	field    ColdVectorField
	stored   atomic.Pointer[coldWrittenStore]
	view     *coldView
	writes   []func() error
	replay   atomic.Pointer[error]
	loaded   chan struct{}
	failure  error
	wanted   chan struct{}
	wantOnce sync.Once
	cancel   context.CancelFunc
}

func (v *coldView) copied() *coldView {
	return &coldView{written: maps.Clone(v.written), removedNumbers: maps.Clone(v.removedNumbers),
		removedIDs: maps.Clone(v.removedIDs), live: v.live, sequence: v.sequence}
}

func (h *coldHold) replayFailure() error {
	if failure := h.replay.Load(); failure != nil {
		return *failure
	}
	return nil
}

func (h *coldHold) wantLoad() {
	h.wantOnce.Do(func() { close(h.wanted) })
}

func (f *Field) coldHoldNow() *coldHold {
	return f.coldNow.Load()
}

func (f *Field) setCold(hold *coldHold) {
	f.cold = hold
	f.coldNow.Store(hold)
}

func (f *Field) retireOlderCopy(view *coldView, docID string) (bool, error) {
	if _, held := view.written[docID]; held {
		delete(view.written, docID)
		return true, nil
	}
	if _, removed := view.removedIDs[docID]; removed {
		return false, nil
	}
	number, held, err := f.cold.field.NumberOf(docID)
	if err != nil || !held {
		return false, err
	}
	view.removedIDs[docID] = struct{}{}
	view.removedNumbers[number] = struct{}{}
	return true, nil
}

func (h *coldHold) insert(docID string, values []float32, field *Field) error {
	view := h.view.copied()
	replaced, err := field.retireOlderCopy(view, docID)
	if err != nil {
		return err
	}
	stored := h.stored.Load()
	if stored == nil {
		created, err := newColdWrittenStore(field.config.dimension, field.config.blockBytes)
		if err != nil {
			return err
		}
		stored = created
		h.stored.Store(stored)
	}
	ordinal, sequence, err := stored.insert(docID, values)
	if err != nil {
		return err
	}
	if !replaced {
		view.live++
	}
	view.written[docID] = ordinal
	view.sequence = sequence
	h.view = view
	return nil
}

func (h *coldHold) commit(sequence int64, field *Field) {
	published := field.coldViewNow.Load()
	if h.view == published {
		return
	}
	h.view.committed = sequence
	h.view.earlier.Store(published)
	oldest := min(field.slots.oldestPin(), sequence-1)
	for kept := published; kept != nil; kept = kept.earlier.Load() {
		if kept.committed <= oldest {
			kept.earlier.Store(nil)
			break
		}
	}
	field.coldViewNow.Store(h.view)
}

func (h *coldHold) remove(docID string, field *Field) (bool, error) {
	view := h.view.copied()
	removed, err := field.retireOlderCopy(view, docID)
	if err != nil || !removed {
		return false, err
	}
	if stored := h.stored.Load(); stored != nil {
		view.sequence = stored.remove(docID)
	}
	view.live--
	h.view = view
	return true, nil
}

func (h *coldHold) release() {
	h.cancel()
	h.field.Close()
	if stored := h.stored.Swap(nil); stored != nil {
		stored.close()
	}
}

func (f *Field) CodeBits() uint32 {
	return f.config.bits
}

func (f *Field) OpenColdField(field ColdVectorField, load ColdFieldLoad) {
	f.writeMu.Lock()
	defer f.writeMu.Unlock()
	if f.disposed {
		field.Close()
		return
	}
	f.cancelColdHold()
	ctx, cancel := context.WithCancel(f.builds.lifetime)
	hold := &coldHold{
		field:  field,
		view:   &coldView{written: map[string]int32{}, removedNumbers: map[int]struct{}{}, removedIDs: map[string]struct{}{}, live: field.LiveCount()},
		loaded: make(chan struct{}),
		wanted: make(chan struct{}),
		cancel: cancel,
	}
	f.setCold(hold)
	f.coldViewNow.Store(hold.view)
	go f.loadCold(ctx, hold, load)
}

func (f *Field) loadCold(ctx context.Context, hold *coldHold, load ColdFieldLoad) {
	stillWanted := func() bool {
		return f.coldHoldNow() == hold
	}
	var begun []*CheckpointRestore
	err := load(ctx, func(shape CheckpointRestoreShape) (*CheckpointRestore, error) {
		restore, err := f.beginCheckpointRestore(ctx, shape)
		if restore != nil {
			begun = append(begun, restore)
		}
		return restore, err
	}, stillWanted, hold.wanted)
	for _, restore := range begun {
		if abortErr := restore.Abort(); abortErr != nil && err == nil {
			err = abortErr
		}
	}
	f.writeMu.Lock()
	defer f.writeMu.Unlock()
	if err != nil {
		hold.failure = err
		close(hold.loaded)
		return
	}
	if f.cold == hold {
		err = f.endColdHold(hold)
		hold.failure = err
	}
	close(hold.loaded)
}

func (f *Field) endColdHold(hold *coldHold) error {
	replayed := max(f.slots.Sequence(), loadedWriteSequence)
	for _, write := range hold.writes {
		if err := write(); err != nil {
			hold.replay.Store(&err)
			hold.writes = nil
			hold.release()
			return err
		}
	}
	f.store.publishSequence(replayed)
	f.setCold(nil)
	f.coldViewNow.Store(nil)
	f.recordAdmittedLive()
	hold.release()
	return nil
}

func (f *Field) cancelColdHold() {
	hold := f.cold
	if hold == nil {
		return
	}
	f.setCold(nil)
	f.coldViewNow.Store(nil)
	hold.release()
}

func (f *Field) UntilColdLoaded(ctx context.Context) error {
	return f.untilColdLoaded(ctx)
}

func (f *Field) untilColdLoaded(ctx context.Context) error {
	for {
		hold := f.coldHoldNow()
		if hold == nil {
			return nil
		}
		hold.wantLoad()
		select {
		case <-hold.loaded:
			if hold.failure != nil {
				return hold.failure
			}
			if f.coldHoldNow() == hold {
				return nil
			}
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}
