package index

import (
	"context"

	"github.com/assetcorp/narsil/packages/go/engine/internal/callerctx"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/analysis"
)

type StoredRead struct {
	index     *Index
	sequence  int64
	present   map[string]bool
	documents map[string][]byte
}

func StoredReadOf(ctx context.Context) *StoredRead {
	read, _ := ctx.Value(storedReadKey{}).(*StoredRead)
	return read
}

func (r *StoredRead) documentsFor(ix *Index, write *Write) map[string][]byte {
	if r == nil || r.index != ix || write.Sequence() != r.sequence+1 {
		return nil
	}
	return r.documents
}

type storedReadKey struct{}

var _ = callerctx.EngineKey(storedReadKey{})

func WithStoredRead(ctx context.Context, read *StoredRead) context.Context {
	if read == nil {
		return ctx
	}
	return context.WithValue(ctx, storedReadKey{}, read)
}

func (ix *Index) unchangedSince(ctx context.Context, read *StoredRead) bool {
	if read == nil || read.index != ix {
		return false
	}
	if _, pinned := ix.pinnedRead(ctx); pinned {
		return false
	}
	return ix.slots.Sequence() == read.sequence
}

func (ix *Index) storedPresence(ctx context.Context, id string) (present bool, known bool) {
	read := StoredReadOf(ctx)
	if !ix.unchangedSince(ctx, read) {
		return false, false
	}
	present, known = read.present[id]
	return present, known
}

func (ix *Index) readStored(ctx context.Context, collecting *analysis.Pass, writes []DocumentWrite) (*StoredRead,
	error) {
	if _, pinned := ix.pinnedRead(ctx); pinned {
		return nil, ix.collectStoredTokens(ctx, collecting, writes, nil)
	}
	read := &StoredRead{index: ix, sequence: ix.slots.Sequence(), present: make(map[string]bool, len(writes)),
		documents: make(map[string][]byte, len(writes))}
	if err := ix.collectStoredTokens(ctx, collecting, writes, read); err != nil {
		return nil, err
	}
	if len(read.present) < len(writes) {
		read.documents = nil
	}
	return read, nil
}
