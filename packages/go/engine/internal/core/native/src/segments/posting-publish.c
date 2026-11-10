#include "postings.h"

#include "../../include/narsil_segments.h"
#include "pools.h"
#include "tokens.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

static void copy_kept(const segment_posting_plan *plan, const segment_posting_change *change,
                      narsil_growing_segment *segment) {
  narsil_posting_pool *pool = &segment->postings;
  uint32_t kept = 0;
  for (size_t index = change->source.start; index < (size_t)change->source.start + change->old_length; index++) {
    uint32_t doc = pool->doc_ids[index];
    if (plan->purging && segment_row_removed(segment, doc)) { continue; }
    size_t target = (size_t)change->target.start + kept++;
    pool->doc_ids[target] = doc;
    pool->frequencies[target] = pool->frequencies[index];
    pool->field_indices[target] = pool->field_indices[index];
    if (pool->position_starts != NULL) {
      pool->position_starts[target] = (change->flags & SEGMENT_TERM_POSITIONS) == 0 ? 0 : pool->position_starts[index];
    }
  }
}

static uint32_t append_rows(const segment_posting_change *change, const segment_token_plan *tokens,
                            const narsil_index_terms_request *request, uint32_t position_end) {
  narsil_growing_segment *segment = request->segment;
  narsil_posting_pool *pool = &segment->postings;
  size_t start = change->first_token;
  size_t output = (size_t)change->target.start + change->kept;
  while (start < change->token_end) {
    segment_token_ref first = tokens->tokens[start];
    size_t end = start + 1;
    while (end < change->token_end && tokens->tokens[end].field == first.field) { end++; }
    size_t count = end - start;
    pool->doc_ids[output] = request->ordinal;
    pool->frequencies[output] = (uint16_t)(count > UINT16_MAX ? UINT16_MAX : count);
    pool->field_indices[output] = first.field;
    if (segment->positions != NULL) {
      pool->position_starts[output] = position_end;
      segment->positions->values[position_end++] = (uint32_t)count;
      for (size_t index = start; index < end; index++) {
        segment->positions->values[position_end++] = tokens->tokens[index].position;
      }
    } else if (pool->position_starts != NULL) {
      pool->position_starts[output] = 0;
    }
    output++;
    start = end;
  }
  return position_end;
}

static void publish_columns(const segment_posting_change *change, const narsil_index_terms_request *request,
                            int purging) {
  narsil_growing_segment *segment = request->segment;
  narsil_term_columns *columns = &segment->columns;
  uint32_t ordinal = change->ordinal;
  uint32_t flags = change->flags;
  if (change->kept > 0 && change->added_rows > 0 && request->ordinal < change->last) {
    flags &= ~(uint32_t)SEGMENT_TERM_ORDERED;
  }
  if (change->added_rows > 0 && segment->positions != NULL) { flags |= SEGMENT_TERM_POSITIONS; }
  columns->slice_start[ordinal] = change->target.start;
  columns->slice_class[ordinal] = change->target.slice_class;
  columns->lengths[ordinal] = change->kept + change->added_rows;
  columns->doc_frequency[ordinal] = change->frequency + (change->added_rows > 0);
  if (purging || change->is_new) { columns->dead_documents[ordinal] = 0; }
  columns->total_term_frequency[ordinal] =
      (change->is_new ? 0 : columns->total_term_frequency[ordinal]) + change->added_frequency;
  if (change->is_new) { columns->surface_occurrences[ordinal] = 0; }
  columns->revision[ordinal] = change->is_new ? 0 : columns->revision[ordinal] + 1;
  columns->flags[ordinal] = (uint8_t)flags;
}

void segment_postings_publish(const segment_posting_plan *plan, const segment_token_plan *tokens,
                              const narsil_index_terms_request *request) {
  narsil_growing_segment *segment = request->segment;
  segment_pool pool = segment_posting_pool(&segment->postings);
  segment_pool_publish(&plan->pool, &pool);
  uint32_t position_end = segment->positions == NULL ? 0 : segment->positions->allocation[SEGMENT_POOL_END];
  for (size_t index = 0; index < plan->count; index++) {
    const segment_posting_change *change = plan->changes + index;
    if (plan->purging || change->source.start != change->target.start) { copy_kept(plan, change, segment); }
    if (!plan->purging && change->source.start == change->target.start && segment->positions != NULL &&
        (change->flags & SEGMENT_TERM_POSITIONS) == 0 && change->kept > 0) {
      memset(segment->postings.position_starts + change->target.start, 0,
             change->kept * sizeof *segment->postings.position_starts);
    }
    position_end = append_rows(change, tokens, request, position_end);
    publish_columns(change, request, plan->purging);
  }
  for (size_t index = 0; index < plan->count; index++) {
    const segment_posting_change *change = plan->changes + index;
    if (change->source.slice_class != SEGMENT_NO_SLICE && change->source.start != change->target.start) {
      segment_pool_release_slice(&pool, change->source);
    }
  }
  if (plan->clear_retired) {
    size_t words =
        segment->ordinal_capacity == 0 ? 1 : (((size_t)segment->ordinal_capacity - 1) / SEGMENT_WORD_BITS) + 1;
    memset(segment->retired, 0, words * sizeof *segment->retired);
  }
  if (segment->positions != NULL) {
    segment->positions->allocation[SEGMENT_POOL_END] = position_end;
    segment->positions->allocation[SEGMENT_POOL_FREE] += plan->freed_positions;
  }
}
