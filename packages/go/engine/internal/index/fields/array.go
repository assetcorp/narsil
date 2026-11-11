package fields

import "github.com/assetcorp/narsil/packages/go/engine/internal/core"

type array[T core.RegionElement] struct {
	name     string
	region   *core.Region
	maxCount uint64
	capacity uint64
}

func newArray[T core.RegionElement](name string, maxCount uint64) array[T] {
	return array[T]{name: name, maxCount: maxCount}
}

func (a *array[T]) reserveExactly(count uint64) error {
	if count <= a.capacity {
		return nil
	}
	if count > a.maxCount {
		return capacityExceeded(a.name, count, a.maxCount)
	}
	elementBytes := uint64(core.RegionElementBytes[T]())
	if a.region == nil {
		region, err := core.ReserveRegion(0, uintptr(a.maxCount*elementBytes))
		if err != nil {
			return regionFailure(a.name, err)
		}
		a.region = region
	}
	if err := a.region.Resize(uintptr(count * elementBytes)); err != nil {
		return regionFailure(a.name, err)
	}
	a.capacity = count
	return nil
}

func (a *array[T]) reserve(count, minimum uint64) error {
	if count <= a.capacity {
		return nil
	}
	if count > a.maxCount {
		return capacityExceeded(a.name, count, a.maxCount)
	}
	return a.reserveExactly(min(a.maxCount, grownCapacity(a.capacity, count, minimum, layoutCountLimit)))
}

func (a *array[T]) all() []T {
	return core.RegionSlice[T](a.region, int(a.capacity))
}

func (a *array[T]) prefix(count uint64) []T {
	if count > a.capacity {
		count = a.capacity
	}
	return core.RegionSlice[T](a.region, int(count))
}

func (a *array[T]) bytes() uint64 {
	return a.capacity * uint64(core.RegionElementBytes[T]())
}

func (a *array[T]) release() {
	if a.region != nil {
		a.region.Release()
		a.region = nil
	}
	a.capacity = 0
}
