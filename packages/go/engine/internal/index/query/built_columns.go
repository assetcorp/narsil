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

func builtColumn[K comparable, C any](held *heldColumns, columns func(*heldColumns) map[K]*C, key K, build func() (*C, error)) (*C, error) {
	held.mu.Lock()
	defer held.mu.Unlock()
	if held.released {
		return nil, releasedColumns()
	}
	built := columns(held)
	if column := built[key]; column != nil {
		return column, nil
	}
	column, err := build()
	if err != nil {
		return nil, err
	}
	built[key] = column
	return column, nil
}

func storedColumns(held *heldColumns) map[string]*fields.Stored {
	return held.stored
}

func sortColumns(held *heldColumns) map[SortColumnKey]*fields.SortColumn {
	return held.sorts
}

func (b *BuiltColumns) Stored(path string, build func() (*fields.Stored, error)) (*fields.Stored, error) {
	return builtColumn(b.held, storedColumns, path, build)
}

func (b *BuiltColumns) Sort(key SortColumnKey, build func() (*fields.SortColumn, error)) (*fields.SortColumn, error) {
	return builtColumn(b.held, sortColumns, key, build)
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
