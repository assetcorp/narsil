package growing

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type fieldLengths struct {
	values          column[uint32]
	totals          column[float64]
	partial         column[uint8]
	documents       []uint32
	ordinalCapacity uint64
	fieldCount      uint64
}

func (f *fieldLengths) reserve(ordinals, fields uint64) error {
	if ordinals > lastOrdinalBound || fields < f.fieldCount || fields > core.MaxSegmentFields {
		return narsilerr.New(narsilerr.CodeConfigInvalid, "The field length columns exceed their ordinal layout",
			map[string]any{"ordinals": float64(ordinals), "fields": float64(fields)})
	}
	capacity := f.ordinalCapacity
	if ordinals > capacity {
		grown, err := grownCapacity(capacity, ordinals)
		if err != nil {
			return err
		}
		capacity = grown
	}
	if capacity == f.ordinalCapacity && fields == f.fieldCount {
		return nil
	}
	if capacity*fields > maxPoolEntries {
		return narsilerr.New(narsilerr.CodePartitionCapacityExceeded,
			"The field length columns need more entries than a keyword segment region holds",
			map[string]any{"ordinals": float64(capacity), "fields": float64(fields)})
	}
	if err := f.values.resize(capacity * fields); err != nil {
		return err
	}
	previous := f.ordinalCapacity
	values := f.values.values
	for field := f.fieldCount; field > 0; field-- {
		from := (field - 1) * previous
		to := (field - 1) * capacity
		copy(values[to:to+previous], values[from:from+previous])
		clear(values[to+previous : to+capacity])
	}
	clear(values[f.fieldCount*capacity:])
	if err := f.totals.resize(fields); err != nil {
		return err
	}
	if err := f.partial.resize(fields); err != nil {
		return err
	}
	f.ordinalCapacity = capacity
	f.fieldCount = fields
	return nil
}

func (f *fieldLengths) bytes() uint64 {
	return f.values.bytes() + f.totals.bytes() + f.partial.bytes() + uint64(len(f.documents))*4
}

func (f *fieldLengths) release() {
	f.values.release()
	f.totals.release()
	f.partial.release()
}
