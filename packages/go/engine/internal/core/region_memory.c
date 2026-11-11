#if defined(__APPLE__) && !defined(_DARWIN_C_SOURCE)
#define _DARWIN_C_SOURCE
#endif

#include "region_memory.h"

#include <stdint.h>
#include <string.h>

#if UINTPTR_MAX > 0xFFFFFFFFu
#define NARSIL_GO_REGION_FIRST_ADDRESS ((uintptr_t)0x400000000000u)
#else
#define NARSIL_GO_REGION_FIRST_ADDRESS ((uintptr_t)0)
#endif

#if defined(_WIN32) || defined(__APPLE__)

static _Atomic uintptr_t narsil_go_region_search_start = NARSIL_GO_REGION_FIRST_ADDRESS;

static uintptr_t search_start(void) {
  uintptr_t start = narsil_go_region_search_start;
  return start < NARSIL_GO_REGION_FIRST_ADDRESS ? NARSIL_GO_REGION_FIRST_ADDRESS : start;
}

static void note_reserved(void *base, size_t bytes) {
  if (base != NULL) { narsil_go_region_search_start = (uintptr_t)base + bytes; }
}

#endif

#ifdef _WIN32

#include <windows.h>

static void *reserve_between(size_t bytes, uintptr_t candidate, uintptr_t limit) {
  SYSTEM_INFO info;
  GetSystemInfo(&info);
  uintptr_t granularity = (uintptr_t)info.dwAllocationGranularity;
  candidate = (candidate + granularity - 1) / granularity * granularity;
  while (candidate != 0 && candidate < limit && bytes <= limit - candidate) {
    MEMORY_BASIC_INFORMATION found;
    if (VirtualQuery((void *)candidate, &found, sizeof(found)) == 0) { return NULL; }
    uintptr_t region_start = (uintptr_t)found.BaseAddress;
    uintptr_t region_end = region_start + found.RegionSize;
    if (found.State == MEM_FREE && region_end - candidate >= bytes) {
      void *base = VirtualAlloc((void *)candidate, bytes, MEM_RESERVE, PAGE_NOACCESS);
      if (base != NULL) { return base; }
    }
    uintptr_t next = (region_end + granularity - 1) / granularity * granularity;
    if (next <= candidate) { return NULL; }
    candidate = next;
  }
  return NULL;
}

static void *reserve_above_first_address(size_t bytes) {
  SYSTEM_INFO info;
  GetSystemInfo(&info);
  uintptr_t highest = (uintptr_t)info.lpMaximumApplicationAddress;
  uintptr_t start = search_start();
  void *base = reserve_between(bytes, start, highest);
  if (base == NULL && start > NARSIL_GO_REGION_FIRST_ADDRESS) {
    base = reserve_between(bytes, NARSIL_GO_REGION_FIRST_ADDRESS, highest);
  }
  return base;
}

void *narsil_go_region_reserve(size_t bytes) {
  if (bytes == 0) { return NULL; }
  void *base = reserve_above_first_address(bytes);
  if (base != NULL) {
    note_reserved(base, bytes);
    return base;
  }
  return VirtualAlloc(NULL, bytes, MEM_RESERVE, PAGE_NOACCESS);
}

int narsil_go_region_commit(void *base, size_t bytes) {
  if (bytes == 0) { return 1; }
  return VirtualAlloc(base, bytes, MEM_COMMIT, PAGE_READWRITE) != NULL;
}

void narsil_go_region_release(void *base, size_t bytes) {
  (void)bytes;
  if (base != NULL) { VirtualFree(base, 0, MEM_RELEASE); }
}

size_t narsil_go_region_page_bytes(void) {
  SYSTEM_INFO info;
  GetSystemInfo(&info);
  return (size_t)info.dwPageSize;
}

#else

#include <sys/mman.h>
#include <unistd.h>

#ifndef MAP_ANONYMOUS
#define MAP_ANONYMOUS MAP_ANON
#endif

static void *map_reserved(uintptr_t hint, size_t bytes) {
  void *base = mmap((void *)hint, bytes, PROT_NONE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  return base == MAP_FAILED ? NULL : base;
}

#ifdef __APPLE__

void *narsil_go_region_reserve(size_t bytes) {
  if (bytes == 0) { return NULL; }
  uintptr_t start = search_start();
  void *base = map_reserved(start, bytes);
  if (base != NULL && (uintptr_t)base < NARSIL_GO_REGION_FIRST_ADDRESS && start > NARSIL_GO_REGION_FIRST_ADDRESS) {
    (void)munmap(base, bytes);
    base = map_reserved(NARSIL_GO_REGION_FIRST_ADDRESS, bytes);
  }
  if (base != NULL && (uintptr_t)base >= NARSIL_GO_REGION_FIRST_ADDRESS) { note_reserved(base, bytes); }
  return base;
}

#else

void *narsil_go_region_reserve(size_t bytes) {
  if (bytes == 0) { return NULL; }
  return map_reserved(0, bytes);
}

#endif

int narsil_go_region_commit(void *base, size_t bytes) {
  if (bytes == 0) { return 1; }
  return mprotect(base, bytes, PROT_READ | PROT_WRITE) == 0;
}

void narsil_go_region_release(void *base, size_t bytes) {
  if (base != NULL && bytes != 0) { (void)munmap(base, bytes); }
}

size_t narsil_go_region_page_bytes(void) {
  long page = sysconf(_SC_PAGESIZE);
  return page > 0 ? (size_t)page : 4096U;
}

#endif

void narsil_go_region_zero(void *base, size_t from, size_t to) {
  if (base == NULL || to <= from) { return; }
  memset((uint8_t *)base + from, 0, to - from);
}
