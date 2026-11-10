package core

import "unsafe"

type RegionElement interface {
	~uint8 | ~uint16 | ~uint32 | ~int32 | ~uint64 | ~float64
}

func RegionElementBytes[T RegionElement]() uintptr {
	var zero T
	return unsafe.Sizeof(zero)
}

func sliceStart[T any](values []T) unsafe.Pointer {
	if len(values) == 0 {
		return nil
	}
	return unsafe.Pointer(unsafe.SliceData(values))
}

func RegionSlice[T RegionElement](region *Region, count int) []T {
	if region == nil || count <= 0 {
		return nil
	}
	region.mu.Lock()
	defer region.mu.Unlock()
	if region.released || uintptr(count) > region.length/RegionElementBytes[T]() {
		return nil
	}
	return unsafe.Slice((*T)(region.base), count)
}
