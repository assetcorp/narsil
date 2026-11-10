package vector

import (
	"context"
	"maps"
	"sync"
)

type ColdVectorField interface {
	LiveCount() int
	ResidentBytes() int
	NumberOf(docID string) (int, bool)
	VectorOfNumber(number int) ([]float32, error)
	PartitionOf(docID string) (int32, bool)
	FilePaths() []string
	Search(ctx context.Context, query []float32, k int, options SearchOptions, admits func(docID string) bool,
		excluded map[int]struct{}) ([]ScoredResult, error)
	Close()
}

type ColdFieldLoad func(ctx context.Context, beginRestore func(shape CheckpointRestoreShape) (*CheckpointRestore, error),
	stillWanted func() bool, loadingWanted <-chan struct{}) error

type coldWritten struct {
	values    []float32
	partition int32
}

type coldView struct {
	written        map[string]coldWritten
	removedNumbers map[int]struct{}
	removedIDs     map[string]struct{}
	live           int
}

type coldHold struct {
	field    ColdVectorField
	view     *coldView
	writes   []func(sequence int64) error
	loaded   chan struct{}
	failure  error
	wanted   chan struct{}
	wantOnce sync.Once
	cancel   context.CancelFunc
}

func (v *coldView) copied() *coldView {
	return &coldView{written: maps.Clone(v.written), removedNumbers: maps.Clone(v.removedNumbers),
		removedIDs: maps.Clone(v.removedIDs), live: v.live}
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

func (f *Field) retireOlderCopy(view *coldView, docID string) bool {
	if _, held := view.written[docID]; held {
		delete(view.written, docID)
		return true
	}
	if _, removed := view.removedIDs[docID]; removed {
		return false
	}
	number, held := f.cold.field.NumberOf(docID)
	if !held {
		return false
	}
	view.removedIDs[docID] = struct{}{}
	view.removedNumbers[number] = struct{}{}
	return true
}

func (h *coldHold) insert(docID string, values []float32, partition int32, field *Field) {
	view := h.view.copied()
	if !field.retireOlderCopy(view, docID) {
		view.live++
	}
	view.written[docID] = coldWritten{values: append([]float32(nil), values...), partition: partition}
	h.view = view
	field.coldViewNow.Store(view)
}

func (h *coldHold) remove(docID string, field *Field) bool {
	view := h.view.copied()
	removed := field.retireOlderCopy(view, docID)
	if removed {
		view.live--
		h.view = view
		field.coldViewNow.Store(view)
	}
	return removed
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
		view:   &coldView{written: map[string]coldWritten{}, removedNumbers: map[int]struct{}{}, removedIDs: map[string]struct{}{}, live: field.LiveCount()},
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
	var failure error
	replayed := max(f.slots.Sequence(), loadedWriteSequence)
	for _, write := range hold.writes {
		if err := write(replayed); err != nil && failure == nil {
			failure = err
		}
	}
	f.store.publishSequence(replayed)
	f.setCold(nil)
	f.coldViewNow.Store(nil)
	hold.field.Close()
	hold.cancel()
	return failure
}

func (f *Field) cancelColdHold() {
	hold := f.cold
	if hold == nil {
		return
	}
	f.setCold(nil)
	f.coldViewNow.Store(nil)
	hold.cancel()
	hold.field.Close()
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
