#if defined(__APPLE__) && !defined(_DARWIN_C_SOURCE)
#define _DARWIN_C_SOURCE
#endif

#include "region_memory.h"

#include <stdint.h>
#include <string.h>

#ifdef _WIN32

#include <windows.h>

void *narsil_go_region_reserve(size_t bytes) {
  if (bytes == 0) { return NULL; }
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

void *narsil_go_region_reserve(size_t bytes) {
  if (bytes == 0) { return NULL; }
  void *base = mmap(NULL, bytes, PROT_NONE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  return base == MAP_FAILED ? NULL : base;
}

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
