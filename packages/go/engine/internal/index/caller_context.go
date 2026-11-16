package index

import (
	"context"
	"time"
)

type callerContext struct {
	context.Context
	done     <-chan struct{}
	deadline time.Time
	timed    bool
}

func withoutCallerCode(ctx context.Context) context.Context {
	deadline, timed := ctx.Deadline()
	return &callerContext{Context: ctx, done: ctx.Done(), deadline: deadline, timed: timed}
}

func (c *callerContext) Deadline() (time.Time, bool) {
	return c.deadline, c.timed
}

func (c *callerContext) Done() <-chan struct{} {
	return c.done
}

func (c *callerContext) Err() error {
	select {
	case <-c.done:
	default:
		return nil
	}
	if c.timed && !time.Now().Before(c.deadline) {
		return context.DeadlineExceeded
	}
	return context.Canceled
}
