package callerctx

import "context"

type cancellationOnly struct {
	context.Context
}

func (c cancellationOnly) Value(any) any {
	return nil
}

func AfterFunc(ctx context.Context, callback func()) func() bool {
	return context.AfterFunc(cancellationOnly{Context: ctx}, callback)
}
