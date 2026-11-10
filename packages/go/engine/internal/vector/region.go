package vector

import (
	"errors"
	"sync/atomic"
	"unsafe"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type growable struct {
	region   *core.Region
	maxBytes uintptr
	length   uintptr
}

func newGrowable(initialBytes, maxBytes uintptr) (*growable, error) {
	initial := min(initialBytes, maxBytes)
	region, err := core.ReserveRegion(initial, maxBytes)
	if err != nil {
		return nil, regionFailure(err, initial, maxBytes)
	}
	return &growable{region: region, maxBytes: maxBytes, length: initial}, nil
}

func regionFailure(err error, bytes, maxBytes uintptr) error {
	if errors.Is(err, core.ErrRegionFull) {
		return narsilerr.New(narsilerr.CodePartitionCapacityExceeded,
			"a vector structure needs more bytes than it may hold",
			map[string]any{"bytes": float64(bytes), "maxBytes": float64(maxBytes)})
	}
	return narsilerr.Wrap(narsilerr.CodePartitionCapacityExceeded,
		"the operating system refused the memory that a vector structure asked for", err,
		map[string]any{"bytes": float64(bytes)})
}

func nextGrowthTarget(have, needed, maxBytes uintptr) uintptr {
	return min(maxBytes, max(needed, have*2))
}

func (g *growable) growTo(bytes uintptr) error {
	if g.length >= bytes {
		return nil
	}
	return g.resize(bytes, nextGrowthTarget(g.length, bytes, g.maxBytes))
}

func (g *growable) growToExactly(bytes uintptr) error {
	if g.length >= bytes {
		return nil
	}
	return g.resize(bytes, bytes)
}

func (g *growable) resize(bytes, target uintptr) error {
	if bytes > g.maxBytes {
		return regionFailure(core.ErrRegionFull, bytes, g.maxBytes)
	}
	if err := g.region.Resize(target); err != nil {
		return regionFailure(err, target, g.maxBytes)
	}
	g.length = target
	return nil
}

func (g *growable) pointer() unsafe.Pointer {
	return g.region.Pointer()
}

func (g *growable) release() {
	g.region.Release()
}

func bytesAt(base unsafe.Pointer, length uintptr) []byte {
	if base == nil || length == 0 {
		return nil
	}
	return unsafe.Slice((*byte)(base), length)
}

func int32Word(base unsafe.Pointer, index int) *atomic.Int32 {
	return (*atomic.Int32)(unsafe.Add(base, uintptr(index)*4))
}

func uint32Word(base unsafe.Pointer, index int) *atomic.Uint32 {
	return (*atomic.Uint32)(unsafe.Add(base, uintptr(index)*4))
}

func float64Slot(base unsafe.Pointer, index int) *float64 {
	return (*float64)(unsafe.Add(base, uintptr(index)*8))
}

func float32Values(base unsafe.Pointer, count int) []float32 {
	if base == nil || count == 0 {
		return nil
	}
	return unsafe.Slice((*float32)(base), count)
}

func int32Values(base unsafe.Pointer, count int) []int32 {
	if base == nil || count == 0 {
		return nil
	}
	return unsafe.Slice((*int32)(base), count)
}

func alignUp(bytes uintptr) uintptr {
	return (bytes + scratchAlignmentBytes - 1) / scratchAlignmentBytes * scratchAlignmentBytes
}

type sharedResource struct {
	refs atomic.Int64
	free func()
}

func newSharedResource(free func()) *sharedResource {
	resource := &sharedResource{free: free}
	resource.refs.Store(1)
	return resource
}

func (r *sharedResource) retain() *sharedResource {
	r.refs.Add(1)
	return r
}

func (r *sharedResource) drop() {
	if r.refs.Add(-1) == 0 {
		r.free()
	}
}
