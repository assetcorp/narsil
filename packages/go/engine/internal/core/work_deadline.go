package core

import (
	"context"
	"math"
	"time"
)

func MeterDeadline(ctx context.Context) uint64 {
	expires, timed := ctx.Deadline()
	if !timed {
		return 0
	}
	now := ClockNow()
	remaining := time.Until(expires)
	if remaining <= 0 {
		return max(now, 1)
	}
	if uint64(remaining) > math.MaxUint64-now {
		return math.MaxUint64
	}
	return now + uint64(remaining)
}
