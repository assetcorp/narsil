#ifndef NARSIL_CORE_ALLOCATION_H
#define NARSIL_CORE_ALLOCATION_H

#include <stddef.h>
#include <stdlib.h>

#ifdef NARSIL_ALLOCATION_FAILURE_TESTS

#define ALLOCATION_SITE_TEXT(line) #line
#define ALLOCATION_SITE_LINE(line) ALLOCATION_SITE_TEXT(line)
#define ALLOCATION_SITE __FILE__ ":" ALLOCATION_SITE_LINE(__LINE__)

int allocation_refused(const char *site);

static inline void *core_allocate_at(size_t bytes, const char *site) {
  return allocation_refused(site) ? NULL : malloc(bytes);
}

static inline void *core_allocate_zeroed_at(size_t count, size_t size, const char *site) {
  return allocation_refused(site) ? NULL : calloc(count, size);
}

static inline void *core_reallocate_at(void *previous, size_t bytes, const char *site) {
  return allocation_refused(site) ? NULL : realloc(previous, bytes);
}

#define core_allocate(bytes) core_allocate_at((bytes), ALLOCATION_SITE)
#define core_allocate_zeroed(count, size) core_allocate_zeroed_at((count), (size), ALLOCATION_SITE)
#define core_reallocate(previous, bytes) core_reallocate_at((previous), (bytes), ALLOCATION_SITE)

#else

static inline void *core_allocate(size_t bytes) { return malloc(bytes); }

static inline void *core_allocate_zeroed(size_t count, size_t size) { return calloc(count, size); }

static inline void *core_reallocate(void *previous, size_t bytes) { return realloc(previous, bytes); }

#endif

#endif
