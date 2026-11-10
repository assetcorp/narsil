package query

import (
	"runtime"
	"sync"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/fields"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type BuiltColumns struct {
	held *heldColumns
}

type heldColumns struct {
	mu       sync.Mutex
	stored   map[string]*fields.Stored
	sorts    map[SortColumnKey]*fields.SortColumn
	released bool
}

func NewBuiltColumns() *BuiltColumns {
	held := &heldColumns{stored: map[string]*fields.Stored{}, sorts: map[SortColumnKey]*fields.SortColumn{}}
	columns := &BuiltColumns{held: held}
	runtime.AddCleanup(columns, (*heldColumns).release, held)
	return columns
}

func releasedColumns() error {
	return narsilerr.New(narsilerr.CodePartitionCorrupted, "A search asked for a column of a partition state that a write already replaced", nil)
}

func (b *BuiltColumns) Stored(path string, build func() (*fields.Stored, error)) (*fields.Stored, error) {
	held := b.held
	held.mu.Lock()
	defer held.mu.Unlock()
	if held.released {
		return nil, releasedColumns()
	}
	if stored := held.stored[path]; stored != nil {
		return stored, nil
	}
	stored, err := build()
	if err != nil {
		return nil, err
	}
	held.stored[path] = stored
	return stored, nil
}

func (b *BuiltColumns) Sort(key SortColumnKey, build func() (*fields.SortColumn, error)) (*fields.SortColumn, error) {
	held := b.held
	held.mu.Lock()
	defer held.mu.Unlock()
	if held.released {
		return nil, releasedColumns()
	}
	if column := held.sorts[key]; column != nil {
		return column, nil
	}
	column, err := build()
	if err != nil {
		return nil, err
	}
	held.sorts[key] = column
	return column, nil
}

func (b *BuiltColumns) Release() {
	if b != nil {
		b.held.release()
	}
}

func (h *heldColumns) release() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.released {
		return
	}
	h.released = true
	for _, column := range h.sorts {
		column.Release()
	}
	for _, stored := range h.stored {
		stored.Release()
	}
	h.sorts, h.stored = nil, nil
}
