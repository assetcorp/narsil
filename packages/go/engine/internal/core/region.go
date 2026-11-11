package core

/*
#include <stdlib.h>
#include "region_memory.h"
*/
import "C"

import (
	"errors"
	"sync"
	"unsafe"
)

var ErrRegionFull = errors.New("the memory region cannot grow past the bytes that it reserved")
var ErrRegionUnavailable = errors.New("the operating system refused the memory that the region asked for")

type Region struct {
	mu        sync.Mutex
	base      unsafe.Pointer
	reserved  uintptr
	committed uintptr
	length    uintptr
	released  bool
}

var pageBytes = uintptr(C.narsil_go_region_page_bytes())

func roundToPage(bytes uintptr) uintptr {
	if bytes == 0 {
		return 0
	}
	return (bytes + pageBytes - 1) / pageBytes * pageBytes
}

func ReserveRegion(initialBytes, maxBytes uintptr) (*Region, error) {
	reserved := roundToPage(maxBytes)
	if reserved == 0 {
		reserved = pageBytes
	}
	base := C.narsil_go_region_reserve(C.size_t(reserved))
	if base == nil {
		return nil, ErrRegionUnavailable
	}
	region := &Region{base: base, reserved: reserved}
	if err := region.Resize(initialBytes); err != nil {
		C.narsil_go_region_release(base, C.size_t(reserved))
		return nil, err
	}
	return region, nil
}

func (r *Region) Resize(bytes uintptr) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.released {
		return ErrRegionUnavailable
	}
	if bytes > r.reserved {
		return ErrRegionFull
	}
	if bytes > r.committed {
		target := roundToPage(bytes)
		if C.narsil_go_region_commit(r.base, C.size_t(target)) == 0 {
			return ErrRegionUnavailable
		}
		r.committed = target
	}
	if bytes < r.length {
		C.narsil_go_region_zero(r.base, C.size_t(bytes), C.size_t(r.length))
	}
	r.length = bytes
	return nil
}

func (r *Region) Pointer() unsafe.Pointer {
	return r.base
}

func (r *Region) Reserved() uintptr {
	return r.reserved
}

func (r *Region) Release() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.released {
		return
	}
	r.released = true
	C.narsil_go_region_release(r.base, C.size_t(r.reserved))
	r.length = 0
	r.committed = 0
}

type Block struct {
	pointer unsafe.Pointer
}

func AllocateBlock(bytes uintptr) (*Block, error) {
	if bytes == 0 {
		bytes = 1
	}
	pointer := C.calloc(1, C.size_t(bytes))
	if pointer == nil {
		return nil, ErrRegionUnavailable
	}
	return &Block{pointer: pointer}, nil
}

func (b *Block) Pointer() unsafe.Pointer {
	return b.pointer
}

func (b *Block) Free() {
	if b.pointer != nil {
		C.free(b.pointer)
		b.pointer = nil
	}
}
