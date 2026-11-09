#include "postings.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_segments.h"
#include "../terms/table.h"
#include "pools.h"
#include "strings.h"
#include "tokens.h"

#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

enum { MIN_POSTING_PLAN = 16, POSTING_PLAN_GROWTH = 2 };

segment_pool segment_posting_pool(const narsil_posting_pool *postings) {
  return (segment_pool){postings->doc_ids,
                        postings->capacity,
                        postings->allocator.allocation,
                        postings->allocator.free_heads,
                        postings->allocator.slice_capacities,
                        postings->allocator.class_count};
}

int segment_row_removed(const narsil_growing_segment *segment, uint32_t doc) {
  return doc >= segment->ordinal_capacity ||
         (segment->retired[doc / SEGMENT_WORD_BITS] & (UINT32_C(1) << (doc % SEGMENT_WORD_BITS))) != 0;
}

static narsil_status reserve_changes(segment_posting_plan *plan, size_t count) {
  if (count <= plan->capacity) { return NARSIL_OK; }
  size_t held = plan->capacity == 0 ? MIN_POSTING_PLAN : plan->capacity;
  while (held < count) {
    if (held > SIZE_MAX / POSTING_PLAN_GROWTH) {
      held = count;
      break;
    }
    held *= POSTING_PLAN_GROWTH;
  }
  if (held > SIZE_MAX / sizeof(segment_posting_change)) { return NARSIL_OUT_OF_MEMORY; }
  segment_posting_change *changes = realloc(plan->changes, held * sizeof *changes);
  if (changes == NULL) { return NARSIL_OUT_OF_MEMORY; }
  plan->changes = changes;
  plan->capacity = held;
  return NARSIL_OK;
}

static narsil_status release_positions(segment_posting_plan *plan, const narsil_growing_segment *segment,
                                       const segment_posting_change *change, size_t index) {
  if (segment->positions == NULL || (change->flags & SEGMENT_TERM_POSITIONS) == 0) { return NARSIL_OK; }
  uint32_t position = segment->postings.position_starts[index];
  if (position == 0) { return NARSIL_OK; }
  if (position >= plan->position_end) { return NARSIL_INVALID_ARGUMENT; }
  uint32_t count = segment->positions->values[position];
  if (count >= plan->position_end - position) { return NARSIL_INVALID_ARGUMENT; }
  if (count + 1 > UINT32_MAX - plan->freed_positions) { return NARSIL_INVALID_ARGUMENT; }
  plan->freed_positions += count + 1;
  return NARSIL_OK;
}

static narsil_status prepare_existing(segment_posting_plan *plan, const narsil_growing_segment *segment,
                                      segment_posting_change *change) {
  const narsil_term_columns *columns = &segment->columns;
  uint32_t ordinal = change->ordinal;
  uint8_t slice_class = columns->slice_class[ordinal];
  const narsil_posting_pool *postings = &segment->postings;
  if (columns->doc_frequency[ordinal] < columns->dead_documents[ordinal] ||
      columns->doc_frequency[ordinal] > columns->lengths[ordinal] ||
      !isfinite(columns->total_term_frequency[ordinal]) || columns->total_term_frequency[ordinal] < 0) {
    return NARSIL_INVALID_ARGUMENT;
  }
  uint32_t start = columns->slice_start[ordinal];
  uint32_t end = postings->allocator.allocation[SEGMENT_POOL_END];
  if (slice_class == SEGMENT_NO_SLICE && columns->lengths[ordinal] == 0 && columns->doc_frequency[ordinal] == 0 &&
      columns->dead_documents[ordinal] == 0) {
    change->source = (segment_slice){0, 0, SEGMENT_NO_SLICE};
    change->flags = SEGMENT_TERM_LIVE | SEGMENT_TERM_ORDERED;
    change->is_new = 1;
    return NARSIL_OK;
  }
  if (slice_class >= postings->allocator.class_count || start > end) { return NARSIL_INVALID_ARGUMENT; }
  uint32_t size = postings->allocator.slice_capacities[slice_class];
  if (size > end - start || columns->lengths[ordinal] > size) { return NARSIL_INVALID_ARGUMENT; }
  change->source = (segment_slice){start, size, slice_class};
  change->old_length = columns->lengths[ordinal];
  change->kept = change->old_length;
  change->flags = columns->flags[ordinal];
  change->frequency = columns->doc_frequency[ordinal];
  change->last = change->old_length == 0 ? 0 : postings->doc_ids[start + change->old_length - 1];
  if (!plan->purging) { return NARSIL_OK; }
  change->kept = 0;
  change->flags |= SEGMENT_TERM_ORDERED;
  change->frequency -= columns->dead_documents[ordinal];
  for (size_t index = start; index < (size_t)start + change->old_length; index++) {
    uint32_t doc = postings->doc_ids[index];
    if (segment_row_removed(segment, doc)) {
      narsil_status status = release_positions(plan, segment, change, index);
      if (status != NARSIL_OK) { return status; }
      continue;
    }
    if (change->kept > 0 && doc < change->last) { change->flags &= ~(uint32_t)SEGMENT_TERM_ORDERED; }
    change->last = doc;
    change->kept++;
  }
  return NARSIL_OK;
}

static size_t find_purged(const segment_posting_plan *plan, uint32_t ordinal) {
  size_t low = 0;
  size_t high = plan->purged_count;
  while (low < high) {
    size_t middle = low + ((high - low) / 2);
    if (plan->changes[middle].ordinal < ordinal) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low < plan->purged_count && plan->changes[low].ordinal == ordinal ? low : SIZE_MAX;
}

static narsil_status prepare_terms(segment_posting_plan *plan, segment_token_plan *tokens,
                                   const narsil_index_terms_request *request) {
  const narsil_growing_segment *segment = request->segment;
  if (plan->purging) {
    for (uint32_t ordinal = 0; ordinal < segment->terms.header[TERM_COUNT]; ordinal++) {
      uint32_t dead = segment->columns.dead_documents[ordinal];
      if ((segment->columns.flags[ordinal] & SEGMENT_TERM_LIVE) == 0 || dead == 0) { continue; }
      if (!plan->clear_retired && dead < segment->columns.doc_frequency[ordinal] &&
          (double)dead / segment->columns.lengths[ordinal] <= SEGMENT_COMPACTION_FRACTION) {
        continue;
      }
      segment_posting_change *change = plan->changes + plan->count++;
      *change = (segment_posting_change){.ordinal = ordinal};
      narsil_status status = prepare_existing(plan, segment, change);
      if (status != NARSIL_OK) { return status; }
    }
  }
  plan->purged_count = plan->count;
  for (size_t index = 0; index < tokens->terms.count; index++) {
    segment_string *entry = tokens->terms.entries + index;
    size_t position = find_purged(plan, entry->ordinal);
    if (position == SIZE_MAX) {
      position = plan->count++;
      segment_posting_change *change = plan->changes + position;
      *change = (segment_posting_change){.ordinal = entry->ordinal,
                                         .is_new = entry->added,
                                         .flags = SEGMENT_TERM_LIVE | SEGMENT_TERM_ORDERED,
                                         .source = {0, 0, SEGMENT_NO_SLICE}};
      if (!entry->added) {
        narsil_status status = prepare_existing(plan, segment, change);
        if (status != NARSIL_OK) { return status; }
      }
    }
    entry->token = (uint32_t)position;
  }
  return NARSIL_OK;
}

static narsil_status prepare_rows(segment_posting_plan *plan, const segment_token_plan *tokens,
                                  const narsil_index_terms_request *request) {
  const narsil_position_pool *positions = request->segment->positions;
  size_t start = 0;
  while (start < tokens->count) {
    segment_token_ref first = tokens->tokens[start];
    size_t end = start + 1;
    while (end < tokens->count && tokens->tokens[end].term == first.term && tokens->tokens[end].field == first.field) {
      end++;
    }
    size_t count = end - start;
    segment_posting_change *change = plan->changes + tokens->terms.entries[first.term].token;
    if (change->added_rows == 0) { change->first_token = start; }
    change->token_end = end;
    change->added_rows++;
    change->added_frequency += (double)(count > UINT16_MAX ? UINT16_MAX : count);
    if (positions != NULL) {
      if (count == UINT32_MAX || count + 1 > positions->capacity - plan->position_end) { return NARSIL_NEEDS_ROOM; }
      plan->position_end += (uint32_t)count + 1;
    }
    start = end;
  }
  return NARSIL_OK;
}

static narsil_status prepare_slices(segment_posting_plan *plan, const segment_pool *pool) {
  for (size_t index = 0; index < plan->count; index++) {
    segment_posting_change *change = plan->changes + index;
    if (change->added_rows > UINT32_MAX - change->kept) { return NARSIL_NEEDS_ROOM; }
    uint32_t length = change->kept + change->added_rows;
    change->target = change->source;
    if (length > change->source.length) {
      narsil_status status = segment_pool_allocate(&plan->pool, pool, length, &change->target);
      if (status != NARSIL_OK) { return status; }
    }
    if (change->added_rows > 0 && change->frequency == UINT32_MAX) { return NARSIL_INVALID_ARGUMENT; }
  }
  return segment_pool_check(&plan->pool);
}

static narsil_status prepare(segment_posting_plan *plan, segment_token_plan *tokens,
                             const narsil_index_terms_request *request, int compact) {
  const narsil_growing_segment *segment = request->segment;
  plan->purging = compact || segment_row_removed(segment, request->ordinal);
  plan->clear_retired = !compact && plan->purging;
  plan->count = 0;
  plan->purged_count = 0;
  plan->position_end = 0;
  plan->freed_positions = 0;
  if (segment->positions != NULL) {
    plan->position_end = segment->positions->allocation[SEGMENT_POOL_END];
    if (plan->position_end == 0 || plan->position_end > segment->positions->capacity ||
        segment->positions->allocation[SEGMENT_POOL_FREE] >= plan->position_end) {
      return NARSIL_INVALID_ARGUMENT;
    }
  }
  size_t count = tokens->terms.count;
  if (plan->purging) {
    if (segment->terms.header[TERM_COUNT] > SIZE_MAX - count) { return NARSIL_OUT_OF_MEMORY; }
    count += segment->terms.header[TERM_COUNT];
  }
  if (count > UINT32_MAX) { return NARSIL_OUT_OF_MEMORY; }
  narsil_status status = reserve_changes(plan, count);
  if (status != NARSIL_OK) { return status; }
  status = segment_pool_reserve(&plan->pool, count);
  if (status != NARSIL_OK) { return status; }
  segment_pool pool = segment_posting_pool(&segment->postings);
  status = segment_pool_begin(&plan->pool, &pool);
  if (status != NARSIL_OK) { return status; }
  status = prepare_terms(plan, tokens, request);
  if (status != NARSIL_OK) { return status; }
  status = prepare_rows(plan, tokens, request);
  if (status != NARSIL_OK) { return status; }
  if (segment->positions != NULL && plan->freed_positions > segment->positions->allocation[SEGMENT_POOL_END] -
                                                                segment->positions->allocation[SEGMENT_POOL_FREE]) {
    return NARSIL_INVALID_ARGUMENT;
  }
  return prepare_slices(plan, &pool);
}

narsil_status segment_postings_prepare(segment_posting_plan *plan, segment_token_plan *tokens,
                                       const narsil_index_terms_request *request) {
  return prepare(plan, tokens, request, 0);
}

narsil_status segment_postings_compact(segment_posting_plan *plan, const narsil_index_terms_request *request) {
  segment_token_plan tokens = {0};
  return prepare(plan, &tokens, request, 1);
}

void segment_postings_release(segment_posting_plan *plan) {
  free(plan->changes);
  segment_pool_release(&plan->pool);
  memset(plan, 0, sizeof *plan);
}

size_t segment_postings_bytes(const segment_posting_plan *plan) {
  return (plan->capacity * sizeof *plan->changes) + segment_pool_bytes(&plan->pool);
}
