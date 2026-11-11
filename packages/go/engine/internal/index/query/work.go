package query

import (
	"context"
	"sync"
	"sync/atomic"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
)

type Work struct {
	once    sync.Once
	ctx     context.Context
	cap     int64
	meter   atomic.Pointer[core.WorkMeter]
	unwatch func() bool
	stopped chan struct{}
	err     error
}

func NewWork(ctx context.Context, cap int64) *Work {
	return &Work{ctx: ctx, cap: cap}
}

func (w *Work) open() {
	if w.err = w.ctx.Err(); w.err != nil {
		return
	}
	meter, err := core.NewWorkMeter(w.cap, core.MeterDeadline(w.ctx))
	if err != nil {
		w.err = err
		return
	}
	if w.ctx.Done() != nil {
		stopped := make(chan struct{})
		w.stopped = stopped
		w.unwatch = context.AfterFunc(w.ctx, func() {
			meter.Stop()
			close(stopped)
		})
	}
	w.meter.Store(meter)
}

func (w *Work) Meter() (*core.WorkMeter, error) {
	w.once.Do(w.open)
	return w.meter.Load(), w.err
}

func (w *Work) opened() *core.WorkMeter {
	return w.meter.Load()
}

func (w *Work) Close() {
	w.once.Do(func() { w.err = ErrStopped })
	meter := w.meter.Swap(nil)
	if meter == nil {
		return
	}
	if w.unwatch != nil && !w.unwatch() {
		<-w.stopped
	}
	meter.Free()
}
