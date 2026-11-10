#ifndef NARSIL_KEYWORD_SCRATCH_H
#define NARSIL_KEYWORD_SCRATCH_H

#include "../../include/narsil_core.h"

#include <stddef.h>
#include <stdint.h>

typedef struct {
  double *scores;
  int32_t *stamps;
  uint32_t *touched;
  uint32_t *scorable;
  uint32_t *seen_bits;
  uint32_t *counted_bits;
  uint32_t capacity;
  int32_t generation;
  uint32_t touched_count;
  uint32_t *covered;
  uint32_t *last_term;
  uint32_t coverage_capacity;
  double *group_best;
  int32_t *group_stamps;
  uint32_t *group_touched;
  uint32_t group_capacity;
  int32_t group_generation;
  uint32_t group_touched_count;
  uint32_t *order;
  uint32_t *order_spare;
  uint32_t order_capacity;
  double *selection;
  uint32_t selection_capacity;
  uint32_t *list_order;
  double *list_bounds;
  double *list_idfs;
  double *remaining_bounds;
  uint32_t list_capacity;
} keyword_scratch;

typedef struct {
  uint32_t capacity;
  int coverage;
  int groups;
  uint32_t order;
  uint32_t selection;
  uint32_t lists;
} keyword_needs;

void keyword_scratch_release(keyword_scratch *scratch);
size_t keyword_scratch_bytes(const keyword_scratch *scratch);
narsil_status keyword_reserve(keyword_scratch *scratch, const keyword_needs *needs);
void keyword_begin(keyword_scratch *scratch);
void keyword_begin_group(keyword_scratch *scratch);

#endif
