#include "vacuum.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_segments.h"
#include "../../include/narsil_terms.h"
#include "../segment_merge/internal.h"
#include "../terms/table.h"
#include "pools.h"
#include "postings.h"
#include "vacuum-runs.h"
#include "vacuum-strings.h"

#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

enum { VACUUM_DEAD_TERMS = 1024, VACUUM_FREE_ROWS = 16384, VACUUM_FREE_POSITIONS = 16384, VACUUM_FREE_RATIO = 4 };

static int sparse_strings(const narsil_surface_table *table) {
  if (table == NULL) { return 0; }
  uint32_t live = table->strings.header[TERM_LIVE_COUNT];
  uint32_t dead = table->strings.header[TERM_COUNT] - live;
  return dead >= VACUUM_DEAD_TERMS && dead > live;
}

static int needed(const narsil_growing_segment *segment) {
  uint32_t count = segment->terms.header[TERM_COUNT];
  uint32_t live = segment->terms.header[TERM_LIVE_COUNT];
  const uint32_t *allocation = segment->postings.allocator.allocation;
  if (count - live >= VACUUM_DEAD_TERMS && count - live > live) { return 1; }
  if (sparse_strings(segment->surfaces) ||
      (segment->spellings != NULL && sparse_strings(&segment->spellings->entries))) {
    return 1;
  }
  if (allocation[SEGMENT_POOL_FREE] >= VACUUM_FREE_ROWS &&
      allocation[SEGMENT_POOL_FREE] > allocation[SEGMENT_POOL_END] / VACUUM_FREE_RATIO) {
    return 1;
  }
  if (segment->positions != NULL) {
    allocation = segment->positions->allocation;
    if (allocation[SEGMENT_POOL_FREE] >= VACUUM_FREE_POSITIONS &&
        allocation[SEGMENT_POOL_FREE] > allocation[SEGMENT_POOL_END] / VACUUM_FREE_RATIO) {
      return 1;
    }
  }
  uint32_t empty = 0;
  for (uint32_t at = 0; at < count; at++) {
    if (segment->columns.doc_frequency[at] == segment->columns.dead_documents[at]) { empty++; }
  }
  return empty >= VACUUM_DEAD_TERMS && empty > count - empty;
}

static narsil_status reserve(segment_vacuum *plan, const narsil_growing_segment *segment) {
  size_t count = segment->terms.header[TERM_COUNT];
  narsil_status status =
      segment_merge_reserve((void **)&plan->mapping, count, &plan->mapping_capacity, sizeof *plan->mapping);
  if (status != NARSIL_OK) { return status; }
  status = segment_merge_reserve((void **)&plan->terms, count, &plan->term_capacity, sizeof *plan->terms);
  if (status != NARSIL_OK) { return status; }
  status = segment_merge_reserve((void **)&plan->slices, count, &plan->slice_capacity, sizeof *plan->slices);
  if (status != NARSIL_OK) { return status; }
  status = segment_merge_reserve((void **)&plan->units, segment->terms.header[TERM_UNITS_USED], &plan->unit_capacity,
                                 sizeof *plan->units);
  if (status != NARSIL_OK) { return status; }
  status = segment_merge_reserve((void **)&plan->rows, segment->postings.allocator.allocation[SEGMENT_POOL_END],
                                 &plan->row_capacity, sizeof *plan->rows);
  if (status != NARSIL_OK || segment->positions == NULL) { return status; }
  return segment_merge_reserve((void **)&plan->positions, segment->positions->allocation[SEGMENT_POOL_END],
                               &plan->position_capacity, sizeof *plan->positions);
}

static narsil_status positions_for(segment_vacuum *plan, const narsil_growing_segment *segment, segment_vacuum_row *row,
                                   size_t index) {
  uint32_t offset = segment->postings.position_starts[index];
  if (offset == 0) { return NARSIL_OK; }
  const narsil_position_pool *pool = segment->positions;
  uint32_t end = pool->allocation[SEGMENT_POOL_END];
  if (offset >= end || pool->values[offset] >= end - offset) { return NARSIL_INVALID_ARGUMENT; }
  size_t length = (size_t)pool->values[offset] + 1;
  if (plan->position_count > end || length > end - plan->position_count) { return NARSIL_INVALID_ARGUMENT; }
  row->positions = (uint32_t)plan->position_count;
  memcpy(plan->positions + plan->position_count, pool->values + offset, length * sizeof *pool->values);
  plan->position_count += length;
  return NARSIL_OK;
}

static narsil_status collect_rows(segment_vacuum *plan, const narsil_growing_segment *segment,
                                  segment_vacuum_term *term, uint32_t ordinal) {
  const narsil_posting_pool *pool = &segment->postings;
  const narsil_term_columns *columns = &segment->columns;
  size_t start = columns->slice_start[ordinal];
  uint32_t last = 0;
  term->row_start = (uint32_t)plan->row_count;
  for (size_t at = start; at < start + columns->lengths[ordinal]; at++) {
    uint32_t doc = pool->doc_ids[at];
    if (doc >= segment->ordinal_capacity || pool->field_indices[at] >= segment->field_count) {
      return NARSIL_INVALID_ARGUMENT;
    }
    if (segment_row_removed(segment, doc)) { continue; }
    if (plan->row_count >= pool->allocator.allocation[SEGMENT_POOL_END]) { return NARSIL_INVALID_ARGUMENT; }
    segment_vacuum_row *row = plan->rows + plan->row_count++;
    *row = (segment_vacuum_row){doc, 0, pool->frequencies[at], pool->field_indices[at]};
    if (term->length > 0 && doc < last) { term->flags = (uint8_t)(term->flags & ~(uint32_t)SEGMENT_TERM_ORDERED); }
    last = doc;
    term->length++;
    if (segment->positions != NULL && (term->flags & SEGMENT_TERM_POSITIONS) != 0) {
      narsil_status status = positions_for(plan, segment, row, at);
      if (status != NARSIL_OK) { return status; }
    }
  }
  if (term->length == 0 || term->frequency > term->length) { return NARSIL_INVALID_ARGUMENT; }
  size_t slice = 0;
  while (slice < pool->allocator.class_count && pool->allocator.slice_capacities[slice] < term->length) { slice++; }
  if (slice == pool->allocator.class_count) { return NARSIL_INVALID_ARGUMENT; }
  term->slice_class = (uint8_t)slice;
  size_t length = pool->allocator.slice_capacities[slice];
  if (length > pool->allocator.allocation[SEGMENT_POOL_END] - term->row_start) { return NARSIL_INVALID_ARGUMENT; }
  plan->row_count = term->row_start + length;
  return NARSIL_OK;
}

static narsil_status collect_term(segment_vacuum *plan, const narsil_growing_segment *segment, uint32_t ordinal) {
  const narsil_term_columns *columns = &segment->columns;
  const narsil_term_table *table = &segment->terms;
  uint32_t start = table->term_offset[ordinal];
  uint32_t length = table->term_length[ordinal];
  if (start > table->header[TERM_UNITS_USED] || length > table->header[TERM_UNITS_USED] - start ||
      length > table->header[TERM_UNITS_USED] - plan->unit_count ||
      term_table_find(table, length == 0 ? NULL : table->units + start, length) != ordinal) {
    return NARSIL_INVALID_ARGUMENT;
  }
  segment_vacuum_term *term = plan->terms + plan->term_count;
  *term = (segment_vacuum_term){.text_start = (uint32_t)plan->unit_count,
                                .text_length = length,
                                .frequency = columns->doc_frequency[ordinal] - columns->dead_documents[ordinal],
                                .revision = columns->revision[ordinal] + 1,
                                .occurrences = columns->total_term_frequency[ordinal],
                                .surfaces = columns->surface_occurrences[ordinal],
                                .flags = columns->flags[ordinal] | SEGMENT_TERM_ORDERED};
  if (length > 0) { memcpy(plan->units + plan->unit_count, table->units + start, length * sizeof *table->units); }
  plan->unit_count += length;
  narsil_status status = collect_rows(plan, segment, term, ordinal);
  if (status != NARSIL_OK) { return status; }
  plan->mapping[ordinal] = (uint32_t)plan->term_count++;
  return NARSIL_OK;
}

static int slice_order(const void *first, const void *second) {
  const segment_slice *left = first;
  const segment_slice *right = second;
  return left->start < right->start ? -1 : left->start > right->start;
}

static int term_counts_invalid(const narsil_term_columns *columns, uint32_t ordinal) {
  return columns->doc_frequency[ordinal] < columns->dead_documents[ordinal] ||
         columns->doc_frequency[ordinal] > columns->lengths[ordinal] ||
         !isfinite(columns->total_term_frequency[ordinal]) || columns->total_term_frequency[ordinal] < 0 ||
         !isfinite(columns->surface_occurrences[ordinal]) || columns->surface_occurrences[ordinal] < 0;
}

static narsil_status validate_columns(segment_vacuum *plan, const narsil_growing_segment *segment) {
  const narsil_term_columns *columns = &segment->columns;
  const narsil_posting_pool *pool = &segment->postings;
  uint32_t end = pool->allocator.allocation[SEGMENT_POOL_END];
  size_t slices = 0;
  size_t live = 0;
  for (uint32_t at = 0; at < plan->source_count; at++) {
    plan->mapping[at] = UINT32_MAX;
    if ((columns->flags[at] & SEGMENT_TERM_LIVE) == 0) { continue; }
    live++;
    if (term_counts_invalid(columns, at)) { return NARSIL_INVALID_ARGUMENT; }
    uint8_t kind = columns->slice_class[at];
    if (kind == SEGMENT_NO_SLICE && columns->lengths[at] == 0) { continue; }
    if (kind >= pool->allocator.class_count || columns->slice_start[at] > end) { return NARSIL_INVALID_ARGUMENT; }
    uint32_t size = pool->allocator.slice_capacities[kind];
    if (size > end - columns->slice_start[at] || columns->lengths[at] > size) { return NARSIL_INVALID_ARGUMENT; }
    plan->slices[slices++] = (segment_slice){columns->slice_start[at], size, kind};
  }
  if (live != segment->terms.header[TERM_LIVE_COUNT]) { return NARSIL_INVALID_ARGUMENT; }
  if (slices > 1) { qsort(plan->slices, slices, sizeof *plan->slices, slice_order); }
  for (size_t at = 1; at < slices; at++) {
    if (plan->slices[at].start - plan->slices[at - 1].start < plan->slices[at - 1].length) {
      return NARSIL_INVALID_ARGUMENT;
    }
  }
  return NARSIL_OK;
}

narsil_status segment_vacuum_prepare(segment_vacuum *plan, const narsil_growing_segment *segment) {
  plan->active = 0;
  if (!needed(segment)) { return NARSIL_OK; }
  plan->source_count = segment->terms.header[TERM_COUNT];
  plan->term_count = 0;
  plan->row_count = 0;
  plan->unit_count = 0;
  plan->position_count = segment->positions == NULL ? 0 : 1;
  narsil_status status = reserve(plan, segment);
  if (status != NARSIL_OK) { return status; }
  status = validate_columns(plan, segment);
  if (status != NARSIL_OK) { return status; }
  for (uint32_t at = 0; at < plan->source_count; at++) {
    if ((segment->columns.flags[at] & SEGMENT_TERM_LIVE) == 0 ||
        segment->columns.doc_frequency[at] == segment->columns.dead_documents[at]) {
      continue;
    }
    status = collect_term(plan, segment, at);
    if (status != NARSIL_OK) { return status; }
  }
  if (plan->term_count >= segment->terms.slot_count) { return NARSIL_INVALID_ARGUMENT; }
  status = segment_string_vacuum_prepare(&plan->surfaces, segment->surfaces, NULL, plan->mapping, plan->source_count);
  if (status != NARSIL_OK) { return status; }
  if (segment->spellings != NULL) {
    status = segment_string_vacuum_prepare(&plan->spellings, &segment->spellings->entries,
                                           segment->spellings->code_points, plan->mapping, plan->source_count);
    if (status != NARSIL_OK) { return status; }
    status = segment_run_vacuum_prepare(&plan->runs, &segment->spellings->runs, &plan->spellings);
    if (status != NARSIL_OK) { return status; }
  }
  plan->active = 1;
  return NARSIL_OK;
}
