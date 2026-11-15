package engine

import (
	"context"
	"sync"

	"github.com/assetcorp/narsil/packages/go/engine/internal/callerctx"
)

type writeEventsKey struct{}

var _ = callerctx.EngineKey(writeEventsKey{})

type pendingWriteEvents struct {
	mu      sync.Mutex
	indexes []string
	closed  bool
}

func (n *Narsil) deferWriteEvents(ctx context.Context) (context.Context, func()) {
	if _, held := ctx.Value(writeEventsKey{}).(*pendingWriteEvents); held {
		return ctx, releasedNothing
	}
	pending := &pendingWriteEvents{}
	return context.WithValue(ctx, writeEventsKey{}, pending), func() {
		pending.mu.Lock()
		indexes := pending.indexes
		pending.indexes = nil
		pending.closed = true
		pending.mu.Unlock()
		for _, indexName := range indexes {
			n.emitWrite(indexName)
		}
	}
}

func (n *Narsil) emitWriteWithin(ctx context.Context, indexName string) {
	if pending, held := ctx.Value(writeEventsKey{}).(*pendingWriteEvents); held {
		pending.mu.Lock()
		if !pending.closed {
			pending.indexes = append(pending.indexes, indexName)
			pending.mu.Unlock()
			return
		}
		pending.mu.Unlock()
	}
	n.emitWrite(indexName)
}
