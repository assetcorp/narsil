package index

import (
	"context"
	"errors"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/query"
)

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
