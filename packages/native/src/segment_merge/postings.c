#include "internal.h"

#include "../../include/narsil_core.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

static int order_rows(const merge_posting *first, const merge_posting *second) {
  if (first->target != second->target) { return first->target < second->target ? -1 : 1; }
  if (first->source != second->source) { return first->source < second->source ? -1 : 1; }
  return first->row < second->row ? -1 : first->row > second->row;
}

static int compare_rows(const void *left, const void *right) { return order_rows(left, right); }

narsil_status segment_merge_rows(segment_merge_scratch *scratch, size_t start, size_t end) {
  size_t needed = 0;
  for (size_t at = start; at < end; at++) {
    const merge_term *term = scratch->terms + at;
    size_t length = term->end - term->start;
    if (length > SIZE_MAX - needed) { return NARSIL_OUT_OF_MEMORY; }
    needed += length;
  }
  void *allocation = scratch->rows;
  narsil_status status = segment_merge_reserve(&allocation, needed, &scratch->row_capacity, sizeof *scratch->rows);
  scratch->rows = allocation;
  if (status != NARSIL_OK) { return status; }
  return segment_merge_fill_rows(scratch, start, end);
}

narsil_status segment_merge_fill_rows(segment_merge_scratch *scratch, size_t start, size_t end) {
  scratch->row_count = 0;
  int ordered = 1;
  for (size_t at = start; at < end; at++) {
    const merge_term *term = scratch->terms + at;
    for (size_t row = term->start; row < term->end; row++) {
      merge_posting posting;
      int found = segment_merge_source_posting(term, (uint32_t)row, &posting);
      if (found < 0) { return NARSIL_INVALID_ARGUMENT; }
      if (found == 0) { continue; }
      if (scratch->row_count > 0 && compare_rows(scratch->rows + scratch->row_count - 1, &posting) > 0) { ordered = 0; }
      scratch->rows[scratch->row_count++] = posting;
    }
  }
  if (!ordered) { qsort(scratch->rows, scratch->row_count, sizeof *scratch->rows, compare_rows); }
  return NARSIL_OK;
}
