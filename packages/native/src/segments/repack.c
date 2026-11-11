#include "../../include/narsil_core.h"
#include "../../include/narsil_segments.h"
#include "../segment_merge/internal.h"
#include "../terms/table.h"
#include "pools.h"
#include "postings.h"
#include "vacuum.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

enum { REPACK_FREE_ROWS = 16384, REPACK_FREE_POSITIONS = 16384, REPACK_FREE_RATIO = 4 };

static int sparse(const uint32_t *allocation, uint32_t minimum) {
  return allocation[SEGMENT_POOL_FREE] >= minimum &&
         allocation[SEGMENT_POOL_FREE] > allocation[SEGMENT_POOL_END] / REPACK_FREE_RATIO;
}

static narsil_status reserve(segment_vacuum *plan, const narsil_growing_segment *segment) {
  narsil_status status =
      segment_merge_reserve((void **)&plan->terms, plan->source_count, &plan->term_capacity, sizeof *plan->terms);
  if (status != NARSIL_OK) { return status; }
  status = segment_merge_reserve((void **)&plan->rows, segment->postings.allocator.allocation[SEGMENT_POOL_END],
                                 &plan->row_capacity, sizeof *plan->rows);
  if (status != NARSIL_OK || !plan->rebuilds_positions || segment->positions == NULL) { return status; }
  return segment_merge_reserve((void **)&plan->positions, segment->positions->allocation[SEGMENT_POOL_END],
                               &plan->position_capacity, sizeof *plan->positions);
}

static int valid_list(const narsil_position_pool *pool, uint32_t offset) {
  uint32_t end = pool->allocation[SEGMENT_POOL_END];
  return offset < end && pool->values[offset] < end - offset;
}

static narsil_status release_positions(segment_vacuum *plan, const narsil_growing_segment *segment, uint32_t offset) {
  if (offset == 0) { return NARSIL_OK; }
  if (!valid_list(segment->positions, offset)) { return NARSIL_INVALID_ARGUMENT; }
  plan->freed_positions += (size_t)segment->positions->values[offset] + 1;
  return NARSIL_OK;
}

static narsil_status copy_positions(segment_vacuum *plan, const narsil_growing_segment *segment, uint32_t offset,
                                    uint32_t *target) {
  *target = offset;
  if (offset == 0 || !plan->rebuilds_positions) { return NARSIL_OK; }
  const narsil_position_pool *pool = segment->positions;
  uint32_t end = pool->allocation[SEGMENT_POOL_END];
  if (!valid_list(pool, offset)) { return NARSIL_INVALID_ARGUMENT; }
  size_t length = (size_t)pool->values[offset] + 1;
  if (plan->position_count > end || length > end - plan->position_count) { return NARSIL_INVALID_ARGUMENT; }
  memcpy(plan->positions + plan->position_count, pool->values + offset, length * sizeof *pool->values);
  *target = (uint32_t)plan->position_count;
  plan->position_count += length;
  return NARSIL_OK;
}

static int keeps_positions(const narsil_growing_segment *segment, uint8_t flags) {
  return segment->positions != NULL && segment->postings.position_starts != NULL &&
         (flags & SEGMENT_TERM_POSITIONS) != 0;
}

static narsil_status keep_row(segment_vacuum *plan, const narsil_growing_segment *segment, segment_vacuum_term *term,
                              size_t source) {
  const narsil_posting_pool *pool = &segment->postings;
  size_t output = (size_t)term->row_start + term->length;
  if (output >= pool->allocator.allocation[SEGMENT_POOL_END]) { return NARSIL_INVALID_ARGUMENT; }
  segment_vacuum_row *row = plan->rows + output;
  *row = (segment_vacuum_row){pool->doc_ids[source], 0, pool->frequencies[source], pool->field_indices[source]};
  term->length++;
  if (!keeps_positions(segment, term->flags)) { return NARSIL_OK; }
  return copy_positions(plan, segment, pool->position_starts[source], &row->positions);
}

static narsil_status choose_slice(segment_vacuum *plan, const narsil_slice_allocator *allocator,
                                  segment_vacuum_term *term) {
  size_t slice = 0;
  while (slice < allocator->class_count && allocator->slice_capacities[slice] < term->length) { slice++; }
  if (slice == allocator->class_count) { return NARSIL_INVALID_ARGUMENT; }
  uint32_t capacity = allocator->slice_capacities[slice];
  if (capacity > allocator->allocation[SEGMENT_POOL_END] - term->row_start) { return NARSIL_INVALID_ARGUMENT; }
  term->slice_class = (uint8_t)slice;
  plan->row_count = (size_t)term->row_start + capacity;
  return NARSIL_OK;
}

static narsil_status repack_term(segment_vacuum *plan, const narsil_growing_segment *segment, uint32_t ordinal) {
  const narsil_term_columns *columns = &segment->columns;
  const narsil_posting_pool *pool = &segment->postings;
  segment_vacuum_term *term = plan->terms + ordinal;
  int releases_positions = keeps_positions(segment, columns->flags[ordinal]) && !plan->rebuilds_positions;
  *term = (segment_vacuum_term){.row_start = (uint32_t)plan->row_count,
                                .flags = (uint8_t)(columns->flags[ordinal] | SEGMENT_TERM_ORDERED)};
  size_t start = columns->slice_start[ordinal];
  uint32_t last = 0;
  for (size_t at = start; at < start + columns->lengths[ordinal]; at++) {
    uint32_t doc = pool->doc_ids[at];
    if (doc >= segment->ordinal_capacity || pool->field_indices[at] >= segment->field_count) {
      return NARSIL_INVALID_ARGUMENT;
    }
    narsil_status status = NARSIL_OK;
    if (segment_row_removed(segment, doc)) {
      if (releases_positions) { status = release_positions(plan, segment, pool->position_starts[at]); }
      if (status != NARSIL_OK) { return status; }
      continue;
    }
    if (term->length > 0 && doc < last) { term->flags = (uint8_t)(term->flags & ~(uint32_t)SEGMENT_TERM_ORDERED); }
    last = doc;
    status = keep_row(plan, segment, term, at);
    if (status != NARSIL_OK) { return status; }
  }
  if (columns->doc_frequency[ordinal] - columns->dead_documents[ordinal] > term->length) {
    return NARSIL_INVALID_ARGUMENT;
  }
  return choose_slice(plan, &pool->allocator, term);
}

static int positions_released(const segment_vacuum *plan, const narsil_growing_segment *segment) {
  if (segment->positions == NULL || plan->rebuilds_positions) { return 1; }
  const uint32_t *allocation = segment->positions->allocation;
  return allocation[SEGMENT_POOL_FREE] <= allocation[SEGMENT_POOL_END] &&
         plan->freed_positions <= (size_t)allocation[SEGMENT_POOL_END] - allocation[SEGMENT_POOL_FREE];
}

narsil_status segment_repack_prepare(segment_vacuum *plan, const narsil_growing_segment *segment) {
  plan->repacking = 0;
  plan->rebuilds_positions =
      segment->positions != NULL && sparse(segment->positions->allocation, REPACK_FREE_POSITIONS);
  if (!plan->rebuilds_positions && !sparse(segment->postings.allocator.allocation, REPACK_FREE_ROWS)) {
    return NARSIL_OK;
  }
  plan->source_count = segment->terms.header[TERM_COUNT];
  plan->row_count = 0;
  plan->position_count = 1;
  plan->freed_positions = 0;
  narsil_status status = reserve(plan, segment);
  if (status != NARSIL_OK) { return status; }
  status = segment_vacuum_validate(plan, segment);
  if (status != NARSIL_OK) { return status; }
  for (uint32_t at = 0; at < plan->source_count; at++) {
    if ((segment->columns.flags[at] & SEGMENT_TERM_LIVE) == 0 || segment_vacuum_holds_no_slice(segment, at)) {
      continue;
    }
    status = repack_term(plan, segment, at);
    if (status != NARSIL_OK) { return status; }
  }
  if (!positions_released(plan, segment)) { return NARSIL_INVALID_ARGUMENT; }
  plan->repacking = 1;
  return NARSIL_OK;
}

static void publish_term(const segment_vacuum *plan, narsil_growing_segment *segment, uint32_t ordinal) {
  const segment_vacuum_term *term = plan->terms + ordinal;
  narsil_term_columns *columns = &segment->columns;
  narsil_posting_pool *pool = &segment->postings;
  for (size_t at = term->row_start; at < (size_t)term->row_start + term->length; at++) {
    segment_vacuum_row row = plan->rows[at];
    pool->doc_ids[at] = row.document;
    pool->frequencies[at] = row.frequency;
    pool->field_indices[at] = row.field;
    if (pool->position_starts != NULL) { pool->position_starts[at] = row.positions; }
  }
  columns->slice_start[ordinal] = term->row_start;
  columns->slice_class[ordinal] = term->slice_class;
  columns->lengths[ordinal] = term->length;
  columns->doc_frequency[ordinal] -= columns->dead_documents[ordinal];
  columns->dead_documents[ordinal] = 0;
  columns->revision[ordinal]++;
  columns->flags[ordinal] = term->flags;
}

void segment_repack_publish(const segment_vacuum *plan, narsil_growing_segment *segment) {
  for (uint32_t at = 0; at < plan->source_count; at++) {
    if ((segment->columns.flags[at] & SEGMENT_TERM_LIVE) == 0 || segment_vacuum_holds_no_slice(segment, at)) {
      continue;
    }
    publish_term(plan, segment, at);
  }
  narsil_slice_allocator *allocator = &segment->postings.allocator;
  allocator->allocation[SEGMENT_POOL_END] = (uint32_t)plan->row_count;
  allocator->allocation[SEGMENT_POOL_FREE] = 0;
  for (size_t at = 0; at < allocator->class_count; at++) { allocator->free_heads[at] = UINT32_MAX; }
  narsil_position_pool *positions = segment->positions;
  if (positions == NULL) { return; }
  if (!plan->rebuilds_positions) {
    positions->allocation[SEGMENT_POOL_FREE] += (uint32_t)plan->freed_positions;
    return;
  }
  positions->values[0] = 0;
  if (plan->position_count > 1) {
    memcpy(positions->values + 1, plan->positions + 1, (plan->position_count - 1) * sizeof *plan->positions);
  }
  positions->allocation[SEGMENT_POOL_END] = (uint32_t)plan->position_count;
  positions->allocation[SEGMENT_POOL_FREE] = 0;
}
