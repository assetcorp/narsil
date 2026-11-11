#include "removal.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_segments.h"
#include "../segment_merge/internal.h"
#include "pools.h"
#include "postings.h"
#include "strings.h"

#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

static size_t first_row(const narsil_index_terms_request *request, uint32_t token) {
  const narsil_growing_segment *segment = request->segment;
  size_t low = segment->columns.slice_start[token];
  if ((segment->columns.flags[token] & SEGMENT_TERM_ORDERED) == 0) { return low; }
  size_t high = low + segment->columns.lengths[token];
  while (low < high) {
    size_t middle = low + ((high - low) / 2);
    if (segment->postings.doc_ids[middle] < request->ordinal) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

static int prepare_positions(segment_removal_plan *plan, uint32_t token, const narsil_growing_segment *segment,
                             size_t row) {
  if (segment->positions == NULL || (segment->columns.flags[token] & SEGMENT_TERM_POSITIONS) == 0) { return 1; }
  uint32_t start = segment->postings.position_starts[row];
  if (start == 0) { return 1; }
  uint32_t end = segment->positions->allocation[SEGMENT_POOL_END];
  if (start >= end || segment->positions->values[start] >= end - start) { return 0; }
  uint32_t count = segment->positions->values[start] + 1;
  if (count > UINT32_MAX - plan->freed_positions) { return 0; }
  plan->freed_positions += count;
  return 1;
}

static narsil_status check_columns(const narsil_growing_segment *segment, uint32_t token) {
  const narsil_term_columns *columns = &segment->columns;
  const narsil_posting_pool *pool = &segment->postings;
  uint32_t start = columns->slice_start[token];
  uint32_t length = columns->lengths[token];
  uint8_t kind = columns->slice_class[token];
  uint32_t end = pool->allocator.allocation[SEGMENT_POOL_END];
  if (columns->doc_frequency[token] < columns->dead_documents[token] || columns->doc_frequency[token] > length ||
      !isfinite(columns->total_term_frequency[token]) || columns->total_term_frequency[token] < 0 ||
      !isfinite(columns->surface_occurrences[token]) || columns->surface_occurrences[token] < 0 || start > end) {
    return NARSIL_INVALID_ARGUMENT;
  }
  if (kind == SEGMENT_NO_SLICE && length == 0) { return NARSIL_OK; }
  if (kind >= pool->allocator.class_count || pool->allocator.slice_capacities[kind] > end - start ||
      length > pool->allocator.slice_capacities[kind]) {
    return NARSIL_INVALID_ARGUMENT;
  }
  return NARSIL_OK;
}

static narsil_status find_document(const narsil_index_terms_request *request, segment_removal_change *change) {
  const narsil_growing_segment *segment = request->segment;
  const narsil_term_columns *columns = &segment->columns;
  const narsil_posting_pool *pool = &segment->postings;
  uint32_t token = change->ordinal;
  uint32_t start = columns->slice_start[token];
  uint32_t length = columns->lengths[token];
  int ordered = (columns->flags[token] & SEGMENT_TERM_ORDERED) != 0;
  for (size_t at = first_row(request, token); at < (size_t)start + length; at++) {
    uint32_t doc = pool->doc_ids[at];
    if (ordered && doc > request->ordinal) { break; }
    if (doc >= segment->ordinal_capacity || pool->field_indices[at] >= segment->field_count) {
      return NARSIL_INVALID_ARGUMENT;
    }
    if (doc == request->ordinal) {
      change->found = 1;
      change->removed_frequency += pool->frequencies[at];
    }
  }
  if (!change->found) { return NARSIL_OK; }
  uint32_t live = columns->doc_frequency[token] - columns->dead_documents[token];
  if (live == 0) { return NARSIL_INVALID_ARGUMENT; }
  change->compact = live == 1 || (double)(columns->dead_documents[token] + 1) / length > SEGMENT_COMPACTION_FRACTION;
  return NARSIL_OK;
}

static narsil_status prepare_slice(const narsil_growing_segment *segment, segment_removal_change *change,
                                   uint32_t *freed_rows) {
  const narsil_posting_pool *pool = &segment->postings;
  const uint32_t *capacities = pool->allocator.slice_capacities;
  uint8_t source_class = segment->columns.slice_class[change->ordinal];
  change->slice_class = source_class;
  if (change->kept > 0) {
    segment_pool slices = segment_posting_pool(pool);
    narsil_status status = segment_pool_trim_class(&slices, source_class, change->kept, &change->slice_class);
    if (status != NARSIL_OK) { return status; }
  }
  uint32_t retained = change->kept == 0 ? 0 : capacities[change->slice_class];
  uint32_t released = capacities[source_class] - retained;
  if (released > pool->allocator.allocation[SEGMENT_POOL_END] - *freed_rows) { return NARSIL_INVALID_ARGUMENT; }
  *freed_rows += released;
  return NARSIL_OK;
}

static narsil_status prepare_change(segment_removal_plan *plan, const narsil_index_terms_request *request,
                                    segment_removal_change *change, uint32_t *freed_rows) {
  const narsil_growing_segment *segment = request->segment;
  uint32_t token = change->ordinal;
  narsil_status status = check_columns(segment, token);
  if (status != NARSIL_OK) { return status; }
  status = find_document(request, change);
  if (status != NARSIL_OK) { return status; }
  if (!change->compact) { return NARSIL_OK; }
  const narsil_term_columns *columns = &segment->columns;
  const narsil_posting_pool *pool = &segment->postings;
  uint32_t start = columns->slice_start[token];
  uint32_t length = columns->lengths[token];
  change->ordered = 1;
  for (size_t at = start; at < (size_t)start + length; at++) {
    uint32_t doc = pool->doc_ids[at];
    if (doc >= segment->ordinal_capacity || pool->field_indices[at] >= segment->field_count) {
      return NARSIL_INVALID_ARGUMENT;
    }
    if (doc == request->ordinal || segment_row_removed(segment, doc)) {
      if (!prepare_positions(plan, token, segment, at)) { return NARSIL_INVALID_ARGUMENT; }
    } else {
      if (change->kept > 0 && doc < change->last) { change->ordered = 0; }
      change->last = doc;
      change->kept++;
    }
  }
  uint32_t live = columns->doc_frequency[token] - columns->dead_documents[token];
  if ((live == 1) != (change->kept == 0) || live - 1 > change->kept) { return NARSIL_INVALID_ARGUMENT; }
  return prepare_slice(segment, change, freed_rows);
}

narsil_status segment_removal_prepare(segment_removal_plan *plan, const narsil_index_terms_request *request,
                                      const segment_strings *terms) {
  const narsil_growing_segment *segment = request->segment;
  const uint32_t *allocation = segment->postings.allocator.allocation;
  if (allocation[SEGMENT_POOL_END] > segment->postings.capacity ||
      allocation[SEGMENT_POOL_FREE] > allocation[SEGMENT_POOL_END]) {
    return NARSIL_INVALID_ARGUMENT;
  }
  if (segment->positions != NULL) {
    const narsil_position_pool *positions = segment->positions;
    if (positions->allocation[SEGMENT_POOL_END] == 0 || positions->allocation[SEGMENT_POOL_END] > positions->capacity ||
        positions->allocation[SEGMENT_POOL_FREE] >= positions->allocation[SEGMENT_POOL_END]) {
      return NARSIL_INVALID_ARGUMENT;
    }
  }
  narsil_status status =
      segment_merge_reserve((void **)&plan->changes, terms->count, &plan->capacity, sizeof *plan->changes);
  if (status != NARSIL_OK) { return status; }
  plan->count = terms->count;
  plan->freed_positions = 0;
  uint32_t freed_rows = allocation[SEGMENT_POOL_FREE];
  for (size_t at = 0; at < terms->count; at++) {
    plan->changes[at] = (segment_removal_change){.ordinal = terms->entries[at].ordinal};
    status = prepare_change(plan, request, plan->changes + at, &freed_rows);
    if (status != NARSIL_OK) { return status; }
  }
  if (segment->positions != NULL && plan->freed_positions > segment->positions->allocation[SEGMENT_POOL_END] -
                                                                segment->positions->allocation[SEGMENT_POOL_FREE]) {
    return NARSIL_INVALID_ARGUMENT;
  }
  return NARSIL_OK;
}

static void compact_rows(const narsil_index_terms_request *request, const segment_removal_change *change) {
  narsil_growing_segment *segment = request->segment;
  narsil_posting_pool *pool = &segment->postings;
  narsil_term_columns *columns = &segment->columns;
  uint32_t token = change->ordinal;
  size_t start = columns->slice_start[token];
  size_t into = start;
  for (size_t at = start; at < start + columns->lengths[token]; at++) {
    uint32_t doc = pool->doc_ids[at];
    if (doc == request->ordinal || segment_row_removed(segment, doc)) { continue; }
    pool->doc_ids[into] = doc;
    pool->frequencies[into] = pool->frequencies[at];
    pool->field_indices[into] = pool->field_indices[at];
    if (pool->position_starts != NULL) { pool->position_starts[into] = pool->position_starts[at]; }
    into++;
  }
  columns->lengths[token] = change->kept;
  columns->doc_frequency[token] -= columns->dead_documents[token];
  columns->dead_documents[token] = 0;
  columns->flags[token] = (uint8_t)(change->ordered ? columns->flags[token] | SEGMENT_TERM_ORDERED
                                                    : columns->flags[token] & ~(uint32_t)SEGMENT_TERM_ORDERED);
}

void segment_removal_publish(const segment_removal_plan *plan, const narsil_index_terms_request *request,
                             const segment_strings *terms) {
  narsil_growing_segment *segment = request->segment;
  narsil_term_columns *columns = &segment->columns;
  segment_pool pool = segment_posting_pool(&segment->postings);
  for (size_t at = 0; at < plan->count; at++) {
    const segment_removal_change *change = plan->changes + at;
    if (!change->found) { continue; }
    uint32_t token = change->ordinal;
    columns->revision[token]++;
    columns->dead_documents[token]++;
    columns->total_term_frequency[token] = fmax(0, columns->total_term_frequency[token] - change->removed_frequency);
    if (!change->compact) { continue; }
    compact_rows(request, change);
    if (change->kept > 0 && columns->slice_class[token] > change->slice_class) {
      uint8_t kind = columns->slice_class[token];
      segment_pool_trim_slice(&pool, (segment_slice){columns->slice_start[token], pool.slice_capacities[kind], kind},
                              change->slice_class);
      columns->slice_class[token] = change->slice_class;
    }
    if (change->kept == 0) {
      uint8_t kind = columns->slice_class[token];
      segment_pool_release_slice(&pool,
                                 (segment_slice){columns->slice_start[token], pool.slice_capacities[kind], kind});
      segment_string_remove(&segment->terms, terms->entries + at);
      columns->slice_class[token] = SEGMENT_NO_SLICE;
      columns->flags[token] = 0;
      columns->total_term_frequency[token] = 0;
    }
  }
  if (segment->positions != NULL) { segment->positions->allocation[SEGMENT_POOL_FREE] += plan->freed_positions; }
}

void segment_removal_release(segment_removal_plan *plan) {
  free(plan->changes);
  *plan = (segment_removal_plan){0};
}

size_t segment_removal_bytes(const segment_removal_plan *plan) { return plan->capacity * sizeof *plan->changes; }
