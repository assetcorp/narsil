#ifndef NARSIL_REGIONS_H
#define NARSIL_REGIONS_H

#include <stddef.h>
#include <stdint.h>

typedef struct {
  uintptr_t start;
  uintptr_t end;
} memory_region;

static inline int region_of(const void *pointer, size_t count, size_t width, memory_region *region) {
  if (width == 0 || count > SIZE_MAX / width || (count > 0 && pointer == NULL)) { return 0; }
  uintptr_t start = (uintptr_t)pointer;
  size_t bytes = count * width;
  if (bytes > UINTPTR_MAX - start) { return 0; }
  region->start = start;
  region->end = start + bytes;
  return 1;
}

static inline int overlaps(memory_region left, memory_region right) {
  return left.start < left.end && right.start < right.end && left.start < right.end && right.start < left.end;
}

#endif
