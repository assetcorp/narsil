package growing

import (
	"errors"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type column[T core.RegionElement] struct {
	region *core.Region
	values []T
}

func widthOf[T core.RegionElement]() uint64 {
	return uint64(core.RegionElementBytes[T]())
}

func newColumn[T core.RegionElement](count uint64) (column[T], error) {
	var created column[T]
	return created, created.resize(count)
}

func (c *column[T]) len() uint64 {
	return uint64(len(c.values))
}

func (c *column[T]) bytes() uint64 {
	return c.len() * widthOf[T]()
}

func (c *column[T]) resize(count uint64) error {
	width := widthOf[T]()
	limit := uint64(maxPoolEntries) * width
	if count > maxPoolEntries {
		return capacityRefusal(count*width, limit, core.ErrRegionFull)
	}
	bytes := count * width
	if c.region == nil {
		region, err := core.ReserveRegion(uintptr(bytes), uintptr(min(limit, max(bytes, columnReserveBytes))))
		if err != nil {
			return capacityRefusal(bytes, limit, err)
		}
		c.region = region
		c.values = core.RegionSlice[T](region, int(count))
		return nil
	}
	err := c.region.Resize(uintptr(bytes))
	if errors.Is(err, core.ErrRegionFull) {
		return c.relocate(count, bytes, limit)
	}
	if err != nil {
		return capacityRefusal(bytes, limit, err)
	}
	c.values = core.RegionSlice[T](c.region, int(count))
	return nil
}

func (c *column[T]) relocate(count, bytes, limit uint64) error {
	reserve := min(limit, max(bytes, uint64(c.region.Reserved())*columnReserveGrowth))
	region, err := core.ReserveRegion(uintptr(bytes), uintptr(reserve))
	if err != nil {
		return capacityRefusal(bytes, limit, err)
	}
	moved := core.RegionSlice[T](region, int(count))
	copy(moved, c.values)
	c.region.Release()
	c.region = region
	c.values = moved
	return nil
}

func (c *column[T]) clearFrom(start uint64) {
	if start < c.len() {
		clear(c.values[start:])
	}
}

func (c *column[T]) release() {
	if c.region != nil {
		c.region.Release()
	}
	c.region = nil
	c.values = nil
}

func capacityRefusal(bytes, limit uint64, cause error) error {
	if errors.Is(cause, core.ErrRegionFull) {
		return narsilerr.New(narsilerr.CodePartitionCapacityExceeded,
			"a keyword segment region needs more bytes than it may hold",
			map[string]any{"bytes": float64(bytes), "maxBytes": float64(limit)})
	}
	return narsilerr.Wrap(narsilerr.CodePartitionCapacityExceeded,
		"the operating system refused the memory that a keyword segment region asked for", cause,
		map[string]any{"bytes": float64(bytes)})
}

func hashUnits(units []uint16) uint32 {
	hash := uint32(fnvOffsetBasis)
	for _, unit := range units {
		hash = (hash ^ uint32(unit&0xff)) * fnvPrime
		hash = (hash ^ uint32(unit>>8)) * fnvPrime
	}
	return hash
}

func hashRun(points []uint32) uint32 {
	hash := uint32(fnvOffsetBasis)
	for _, point := range points {
		for shift := 0; shift < runPointBytes*8; shift += 8 {
			hash = (hash ^ ((point >> shift) & 0xff)) * fnvPrime
		}
	}
	return hash
}

var sliceCapacities = func() []uint32 {
	capacities := []uint32{1}
	for capacities[len(capacities)-1] < maxPoolEntries {
		previous := uint64(capacities[len(capacities)-1])
		capacities = append(capacities, uint32(min(maxPoolEntries, max(previous+1, (previous*3+1)/2))))
	}
	return capacities
}()

func sliceClassFor(entries uint64) uint8 {
	low, high := 0, len(sliceCapacities)-1
	for low < high {
		middle := (low + high) / 2
		if uint64(sliceCapacities[middle]) < entries {
			low = middle + 1
		} else {
			high = middle
		}
	}
	return uint8(low)
}

func sliceCapacity(class uint8) uint64 {
	if int(class) >= len(sliceCapacities) {
		return 0
	}
	return uint64(sliceCapacities[class])
}

func grownCapacity(current, needed uint64) (uint64, error) {
	if needed > maxPoolEntries {
		return 0, narsilerr.New(narsilerr.CodePartitionCapacityExceeded,
			"a keyword segment pool exceeds its uint32 address space", map[string]any{"entries": float64(needed)})
	}
	return min(maxPoolEntries, max(needed, (current*3+1)/2)), nil
}

func freeHeadsFilled() []uint32 {
	heads := make([]uint32, len(sliceCapacities))
	for at := range heads {
		heads[at] = noFreeSlice
	}
	return heads
}
