#ifndef NARSIL_SEGMENT_POSTINGS_H
#define NARSIL_SEGMENT_POSTINGS_H

#include "../../include/narsil_core.h"
#include "../../include/narsil_segments.h"
#include "pools.h"
#include "tokens.h"

#include <stddef.h>
#include <stdint.h>

enum { SEGMENT_TERM_LIVE = 1, SEGMENT_TERM_ORDERED = 2, SEGMENT_TERM_POSITIONS = 4 };
enum { SEGMENT_WORD_BITS = 32 };
#define SEGMENT_COMPACTION_FRACTION 0.3

typedef struct {
  uint32_t ordinal;
  uint32_t old_length;
  uint32_t kept;
  uint32_t frequency;
  uint32_t last;
  uint32_t added_rows;
  uint32_t flags;
  uint32_t is_new;
  double added_frequency;
  size_t first_token;
  size_t token_end;
  segment_slice source;
  segment_slice target;
} segment_posting_change;

typedef struct {
  segment_posting_change *changes;
  size_t capacity;
  size_t count;
  size_t purged_count;
  int purging;
  int clear_retired;
  uint32_t position_end;
  uint32_t freed_positions;
  segment_pool_plan pool;
} segment_posting_plan;

narsil_status segment_postings_prepare(segment_posting_plan *plan, segment_token_plan *tokens,
                                       const narsil_index_terms_request *request);
narsil_status segment_postings_compact(segment_posting_plan *plan, const narsil_index_terms_request *request);
void segment_postings_publish(const segment_posting_plan *plan, const segment_token_plan *tokens,
                              const narsil_index_terms_request *request);
void segment_postings_release(segment_posting_plan *plan);
size_t segment_postings_bytes(const segment_posting_plan *plan);
segment_pool segment_posting_pool(const narsil_posting_pool *postings);
int segment_row_removed(const narsil_growing_segment *segment, uint32_t doc);

#endif
