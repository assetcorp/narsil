package core

/*
#include <stdlib.h>
#include "native/include/narsil_paged.h"
*/
import "C"

import (
	"errors"
	"math"
	"runtime"
	"strings"
	"sync"
	"unsafe"
)

const PageSlotBytes = C.NARSIL_PAGE_SLOT_BYTES

var ErrPagedFileClosed = errors.New("the paged file was closed before the operation started")

var ErrPagedFileChanged = errors.New("the paged file reopened with another length")

type PagedFile struct {
	mu         sync.Mutex
	idle       *sync.Cond
	file       *C.narsil_paged_file
	identity   uint64
	length     uint64
	users      int
	closing    bool
	suspending bool
	cleanup    runtime.Cleanup
}

func closeNativePagedFile(file *C.narsil_paged_file) {
	C.narsil_paged_file_close(file)
}

func openNativePagedFile(path string) (*C.narsil_paged_file, error) {
	if path == "" || strings.IndexByte(path, 0) >= 0 {
		return nil, &StatusError{Operation: "openPagedFile", Status: StatusInvalidArgument}
	}
	text := C.CString(path)
	defer C.free(unsafe.Pointer(text))
	var opened *C.narsil_paged_file
	if err := statusError("openPagedFile", C.narsil_paged_file_open(text, &opened)); err != nil {
		return nil, err
	}
	return opened, nil
}

func OpenPagedFile(path string) (*PagedFile, error) {
	opened, err := openNativePagedFile(path)
	if err != nil {
		return nil, err
	}
	file := &PagedFile{
		file:     opened,
		identity: uint64(C.narsil_paged_file_identity(opened)),
		length:   uint64(C.narsil_paged_file_length(opened)),
	}
	file.idle = sync.NewCond(&file.mu)
	file.cleanup = runtime.AddCleanup(file, closeNativePagedFile, opened)
	return file, nil
}

func (p *PagedFile) Suspend() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closing || p.file == nil || p.suspending {
		return ErrPagedFileClosed
	}
	p.suspending = true
	for p.users > 0 {
		p.idle.Wait()
	}
	p.suspending = false
	if p.file == nil {
		return ErrPagedFileClosed
	}
	p.closeNow()
	return nil
}

func (p *PagedFile) Resume(path string) error {
	opened, err := openNativePagedFile(path)
	if err != nil {
		return err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closing || p.file != nil {
		C.narsil_paged_file_close(opened)
		return ErrPagedFileClosed
	}
	if length := uint64(C.narsil_paged_file_length(opened)); length != p.length {
		C.narsil_paged_file_close(opened)
		return ErrPagedFileChanged
	}
	p.file = opened
	p.identity = uint64(C.narsil_paged_file_identity(opened))
	p.cleanup = runtime.AddCleanup(p, closeNativePagedFile, opened)
	return nil
}

func (p *PagedFile) Identity() uint64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.identity
}

func (p *PagedFile) Length() uint64 {
	return p.length
}

func (p *PagedFile) acquire() (*C.narsil_paged_file, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closing || p.file == nil || p.suspending {
		return nil, ErrPagedFileClosed
	}
	p.users++
	return p.file, nil
}

func (p *PagedFile) done() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.users--
	if p.users > 0 {
		return
	}
	if p.closing {
		p.closeNow()
	}
	p.idle.Broadcast()
}

func (p *PagedFile) Close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.closing = true
	if p.users == 0 {
		p.closeNow()
	}
}

func (p *PagedFile) closeNow() {
	if p.file == nil {
		return
	}
	p.cleanup.Stop()
	C.narsil_paged_file_close(p.file)
	p.file = nil
}

type heldFiles struct {
	files []*PagedFile
}

func (h *heldFiles) section(held *pins, section *PageSection) (C.narsil_page_section, error) {
	if section == nil || section.File == nil {
		return C.narsil_page_section{}, &StatusError{Operation: "describePageSection", Status: StatusInvalidArgument}
	}
	file, err := section.File.acquire()
	if err != nil {
		return C.narsil_page_section{}, err
	}
	h.files = append(h.files, section.File)
	return C.narsil_page_section{
		file:           file,
		offset:         C.uint64_t(section.Offset),
		length:         C.uint64_t(section.Length),
		page_bytes:     C.uint32_t(section.PageBytes),
		checksums:      (*C.uint8_t)(pinned(held, section.Checksums)),
		checksum_bytes: C.size_t(len(section.Checksums)),
	}, nil
}

func (h *heldFiles) release() {
	for _, file := range h.files {
		file.done()
	}
	h.files = nil
}

type PageCache struct {
	resources *pageCacheResources
	cleanup   runtime.Cleanup
}

type pageCacheResources struct {
	cache *C.narsil_page_cache
}

func releasePageCacheResources(resources *pageCacheResources) {
	cache := resources.cache
	if cache == nil {
		return
	}
	C.free(unsafe.Pointer(cache.bytes))
	C.free(unsafe.Pointer(cache.files))
	C.free(unsafe.Pointer(cache.offsets))
	C.free(unsafe.Pointer(cache.pages))
	C.free(unsafe.Pointer(cache.lengths))
	C.free(unsafe.Pointer(cache.checksums))
	C.free(unsafe.Pointer(cache))
	resources.cache = nil
}

func NewPageCache(slots int) (*PageCache, error) {
	if slots < 1 || uint64(slots) > uint64(math.MaxInt)/PageSlotBytes {
		return nil, &StatusError{Operation: "createPageCache", Status: StatusInvalidArgument}
	}
	cache := (*C.narsil_page_cache)(C.calloc(1, C.size_t(unsafe.Sizeof(C.narsil_page_cache{}))))
	if cache == nil {
		return nil, &StatusError{Operation: "createPageCache", Status: StatusOutOfMemory}
	}
	resources := &pageCacheResources{cache: cache}
	count := C.size_t(slots)
	cache.bytes = (*C.uint8_t)(C.calloc(count, PageSlotBytes))
	cache.files = (*C.uint64_t)(C.calloc(count, C.size_t(unsafe.Sizeof(C.uint64_t(0)))))
	cache.offsets = (*C.uint64_t)(C.calloc(count, C.size_t(unsafe.Sizeof(C.uint64_t(0)))))
	cache.pages = (*C.uint64_t)(C.calloc(count, C.size_t(unsafe.Sizeof(C.uint64_t(0)))))
	cache.lengths = (*C.uint32_t)(C.calloc(count, C.size_t(unsafe.Sizeof(C.uint32_t(0)))))
	cache.checksums = (*C.uint32_t)(C.calloc(count, C.size_t(unsafe.Sizeof(C.uint32_t(0)))))
	if cache.bytes == nil || cache.files == nil || cache.offsets == nil || cache.pages == nil || cache.lengths == nil ||
		cache.checksums == nil {
		releasePageCacheResources(resources)
		return nil, &StatusError{Operation: "createPageCache", Status: StatusOutOfMemory}
	}
	cache.byte_capacity = count * PageSlotBytes
	cache.slots = count
	created := &PageCache{resources: resources}
	created.cleanup = runtime.AddCleanup(created, releasePageCacheResources, resources)
	return created, nil
}

func (c *PageCache) Slots() int {
	if c == nil || c.resources.cache == nil {
		return 0
	}
	return int(c.resources.cache.slots)
}

func (c *PageCache) Free() {
	if c == nil || c.resources.cache == nil {
		return
	}
	c.cleanup.Stop()
	releasePageCacheResources(c.resources)
}

func (c *PageCache) pointer() (*C.narsil_page_cache, error) {
	if c == nil {
		return nil, nil
	}
	if c.resources.cache == nil {
		return nil, ErrHandleReleased
	}
	return c.resources.cache, nil
}
