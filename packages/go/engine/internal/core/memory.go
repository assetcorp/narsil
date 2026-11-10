package core

/*
#include <stdlib.h>
#include "native/include/narsil_core.h"
*/
import "C"

import (
	"errors"
	"sync/atomic"
	"unsafe"
)

var ErrHandleReleased = errors.New("the native search core handle was released")

type GraphRegions struct {
	Header         unsafe.Pointer
	NodeLevels     unsafe.Pointer
	Level0         unsafe.Pointer
	UpperBase      unsafe.Pointer
	Upper          unsafe.Pointer
	Locks          unsafe.Pointer
	Tombstones     unsafe.Pointer
	Incoming       unsafe.Pointer
	NearestLinkDue unsafe.Pointer
	HeldLocks      unsafe.Pointer
	ThreadSlots    uint32
}

type Graph struct {
	graph *C.narsil_graph
}

func NewGraph(regions GraphRegions) (*Graph, error) {
	if regions.Header == nil || regions.HeldLocks == nil || regions.ThreadSlots == 0 {
		return nil, &StatusError{Operation: "attachGraph", Status: StatusInvalidArgument}
	}
	native := (*C.narsil_graph)(C.calloc(1, C.size_t(unsafe.Sizeof(C.narsil_graph{}))))
	if native == nil {
		return nil, &StatusError{Operation: "attachGraph", Status: StatusOutOfMemory}
	}
	graph := &Graph{graph: native}
	graph.bind(regions)
	return graph, nil
}

func (g *Graph) bind(regions GraphRegions) {
	g.graph.header = (*C.int32_t)(regions.Header)
	g.graph.node_levels = (*C.uint8_t)(regions.NodeLevels)
	g.graph.level0 = (*C.int32_t)(regions.Level0)
	g.graph.upper_base = (*C.int32_t)(regions.UpperBase)
	g.graph.upper = (*C.int32_t)(regions.Upper)
	g.graph.locks = (*C.int32_t)(regions.Locks)
	g.graph.tombstones = (*C.uint8_t)(regions.Tombstones)
	g.graph.incoming = (*C.int32_t)(regions.Incoming)
	g.graph.nearest_link_due = (*C.uint8_t)(regions.NearestLinkDue)
	g.graph.held_locks = (*C.int32_t)(regions.HeldLocks)
	g.graph.thread_slots = C.uint32_t(regions.ThreadSlots)
	g.graph.wake = nil
	g.graph.wake_context = nil
}

func (g *Graph) ThreadSlots() uint32 {
	return uint32(g.graph.thread_slots)
}

func (g *Graph) Free() {
	if g.graph != nil {
		C.free(unsafe.Pointer(g.graph))
		g.graph = nil
	}
}

type StoreLayout struct {
	Header             unsafe.Pointer
	Dimension          uint32
	Bits               uint32
	CodeBlocks         []unsafe.Pointer
	RecordsPerBlock    uint32
	CodePresent        unsafe.Pointer
	Centroid           unsafe.Pointer
	VectorBlocks       []unsafe.Pointer
	VectorsPerBlock    uint32
	VectorStrideFloats uint32
	Magnitudes         unsafe.Pointer
	Present            unsafe.Pointer
	VectorFile         unsafe.Pointer
	VectorOffset       unsafe.Pointer
	Files              []*VectorFile
}

type Store struct {
	store        *C.narsil_store
	codeBlocks   unsafe.Pointer
	vectorBlocks unsafe.Pointer
	files        unsafe.Pointer
	users        atomic.Int64
	retired      atomic.Bool
	freed        atomic.Bool
}

func NewStore(layout StoreLayout) (*Store, error) {
	native := (*C.narsil_store)(C.calloc(1, C.size_t(unsafe.Sizeof(C.narsil_store{}))))
	if native == nil {
		return nil, &StatusError{Operation: "attachStore", Status: StatusOutOfMemory}
	}
	store := &Store{store: native}
	if err := store.bind(layout); err != nil {
		store.release()
		return nil, err
	}
	return store, nil
}

func (s *Store) Acquire() bool {
	s.users.Add(1)
	if s.retired.Load() {
		s.Done()
		return false
	}
	return true
}

func (s *Store) Done() {
	if s.users.Add(-1) == 0 && s.retired.Load() {
		s.release()
	}
}

func (s *Store) Retire() {
	s.retired.Store(true)
	if s.users.Load() == 0 {
		s.release()
	}
}

func (s *Store) release() {
	if !s.freed.CompareAndSwap(false, true) {
		return
	}
	C.free(s.codeBlocks)
	C.free(s.vectorBlocks)
	C.free(s.files)
	C.free(unsafe.Pointer(s.store))
}

func pointerTable(pointers []unsafe.Pointer) (unsafe.Pointer, error) {
	table := C.calloc(C.size_t(max(1, len(pointers))), C.size_t(unsafe.Sizeof(uintptr(0))))
	if table == nil {
		return nil, &StatusError{Operation: "attachStore", Status: StatusOutOfMemory}
	}
	copy(unsafe.Slice((*unsafe.Pointer)(table), max(1, len(pointers))), pointers)
	return table, nil
}

func (s *Store) bind(layout StoreLayout) error {
	if layout.Header == nil || layout.Dimension == 0 || layout.VectorStrideFloats < layout.Dimension {
		return &StatusError{Operation: "attachStore", Status: StatusInvalidArgument}
	}
	codeBlocks, err := pointerTable(layout.CodeBlocks)
	if err != nil {
		return err
	}
	vectorBlocks, err := pointerTable(layout.VectorBlocks)
	if err != nil {
		C.free(codeBlocks)
		return err
	}
	files := C.calloc(C.size_t(max(1, len(layout.Files))), C.size_t(unsafe.Sizeof(C.narsil_vector_file{})))
	if files == nil {
		C.free(codeBlocks)
		C.free(vectorBlocks)
		return &StatusError{Operation: "attachStore", Status: StatusOutOfMemory}
	}
	fileTable := unsafe.Slice((*C.narsil_vector_file)(files), max(1, len(layout.Files)))
	for index, file := range layout.Files {
		if file != nil {
			fileTable[index] = file.file
		}
	}
	s.store.header = (*C.int32_t)(layout.Header)
	s.store.dimension = C.uint32_t(layout.Dimension)
	s.store.bits = C.uint32_t(layout.Bits)
	s.store.code_blocks = (**C.uint8_t)(codeBlocks)
	s.store.code_block_count = C.uint32_t(len(layout.CodeBlocks))
	s.store.records_per_block = C.uint32_t(layout.RecordsPerBlock)
	s.store.code_present = (*C.uint8_t)(layout.CodePresent)
	s.store.centroid = (*C.float)(layout.Centroid)
	s.store.vector_blocks = (**C.float)(vectorBlocks)
	s.store.vector_block_count = C.uint32_t(len(layout.VectorBlocks))
	s.store.vectors_per_block = C.uint32_t(layout.VectorsPerBlock)
	s.store.vector_stride_floats = C.uint32_t(layout.VectorStrideFloats)
	s.store.magnitudes = (*C.double)(layout.Magnitudes)
	s.store.present = (*C.uint8_t)(layout.Present)
	s.store.vector_file = (*C.int32_t)(layout.VectorFile)
	s.store.vector_offset = (*C.uint32_t)(layout.VectorOffset)
	s.store.files = (*C.narsil_vector_file)(files)
	s.store.file_count = C.uint32_t(len(layout.Files))
	s.codeBlocks, s.vectorBlocks, s.files = codeBlocks, vectorBlocks, files
	return nil
}

func (s *Store) Dimension() uint32 {
	return uint32(s.store.dimension)
}

type VectorFile struct {
	file C.narsil_vector_file
}

func MapVectorFile(path string) (*VectorFile, error) {
	text := C.CString(path)
	defer C.free(unsafe.Pointer(text))
	mapped := &VectorFile{}
	if status := C.narsil_vector_file_map(text, &mapped.file); status != C.NARSIL_OK {
		return nil, statusError("mapVectorFile", status)
	}
	return mapped, nil
}

func (f *VectorFile) Bytes() []byte {
	if f.file.bytes == nil {
		return nil
	}
	return unsafe.Slice((*byte)(unsafe.Pointer(f.file.bytes)), int(f.file.length))
}

func (f *VectorFile) Unmap() {
	C.narsil_vector_file_unmap(&f.file)
}
