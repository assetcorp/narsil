package index

import (
	"context"
	"errors"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/query"
)

func openWorkMeter(ctx context.Context, workCap int64) (*core.WorkMeter, func(), error) {
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	meter, err := core.NewWorkMeter(workCap, core.MeterDeadline(ctx))
	if err != nil {
		return nil, nil, err
	}
	stopped := make(chan struct{})
	unwatch := context.AfterFunc(ctx, func() {
		meter.Stop()
		close(stopped)
	})
	return meter, func() {
		if !unwatch() {
			<-stopped
		}
		meter.Free()
	}, nil
}

func stoppedSearchFailure(ctx context.Context, err error) error {
	if !errors.Is(err, query.ErrStopped) {
		return err
	}
	if cause := ctx.Err(); cause != nil {
		return cause
	}
	if _, timed := ctx.Deadline(); timed {
		return context.DeadlineExceeded
	}
	return err
}
