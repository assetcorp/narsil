#include "internal.h"

#include "../../include/narsil_core.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

enum { MERGE_INITIAL_CAPACITY = 32, MERGE_CAPACITY_GROWTH = 2 };

narsil_status segment_merge_reserve(void **allocation, size_t count, size_t *held, size_t width) {
  if (count <= *held) { return NARSIL_OK; }
  size_t capacity = *held == 0 ? MERGE_INITIAL_CAPACITY : *held;
  while (capacity < count) {
    if (capacity > SIZE_MAX / MERGE_CAPACITY_GROWTH) {
      capacity = count;
      break;
    }
    capacity *= MERGE_CAPACITY_GROWTH;
  }
  if (width == 0 || capacity > SIZE_MAX / width) { return NARSIL_OUT_OF_MEMORY; }
  void *next = realloc(*allocation, capacity * width);
  if (next == NULL) { return NARSIL_OUT_OF_MEMORY; }
  *allocation = next;
  *held = capacity;
  return NARSIL_OK;
}

void segment_merge_release(segment_merge_scratch *scratch) {
  free(scratch->terms);
  free(scratch->rows);
  free(scratch->surfaces);
  free(scratch->spellings);
  free(scratch->mapped);
  free(scratch->text);
  *scratch = (segment_merge_scratch){0};
}

size_t segment_merge_bytes(const segment_merge_scratch *scratch) {
  return (scratch->term_capacity * sizeof *scratch->terms) + (scratch->row_capacity * sizeof *scratch->rows) +
         (scratch->surface_capacity * sizeof *scratch->surfaces) +
         (scratch->spelling_capacity * sizeof *scratch->spellings) +
         (scratch->mapped_capacity * sizeof *scratch->mapped) + scratch->text_capacity;
}
