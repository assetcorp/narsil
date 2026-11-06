#include "scratch.h"

#include "../internal.h"

#include "../../include/narsil_core.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define FIRST_ORDER_CAPACITY 256U
#define FIRST_SELECTION_CAPACITY 16U
#define FIRST_LIST_CAPACITY 16U
#define MAX_GENERATION INT32_MAX
#define BITS_PER_WORD 32U
#define BITSETS_PER_SCRATCH 3U
#define TOUCHED_SPARE_ENTRIES 1U

static void *allocation(size_t count, size_t size) {
  if (count == 0 || count > SIZE_MAX / size) { return NULL; }
  return malloc(count * size);
}

static void *zeroed_allocation(size_t count, size_t size) {
  if (count == 0) { return NULL; }
  return calloc(count, size);
}

void keyword_scratch_release(keyword_scratch *scratch) {
  free(scratch->scores);
  free(scratch->stamps);
  free(scratch->touched);
  free(scratch->scorable);
  free(scratch->seen_bits);
  free(scratch->counted_bits);
  free(scratch->covered);
  free(scratch->last_term);
  free(scratch->group_best);
  free(scratch->group_stamps);
  free(scratch->group_touched);
  free(scratch->order);
  free(scratch->order_spare);
  free(scratch->selection);
  free(scratch->list_order);
  free(scratch->list_bounds);
  free(scratch->list_idfs);
  free(scratch->remaining_bounds);
  memset(scratch, 0, sizeof *scratch);
}

size_t keyword_scratch_bytes(const keyword_scratch *scratch) {
  size_t per_ordinal = sizeof(double) + sizeof(int32_t) + sizeof(uint32_t);
  size_t per_covered = 2 * sizeof(uint32_t);
  size_t per_group = sizeof(double) + sizeof(int32_t) + sizeof(uint32_t);
  size_t per_list = sizeof(uint32_t) + (3 * sizeof(double));
  size_t remaining_end = scratch->list_capacity > 0 ? sizeof(double) : 0;
  size_t bitset_words = (size_t)(scratch->capacity / BITS_PER_WORD) + 1;
  size_t ordinal_extras =
      scratch->capacity > 0 ? sizeof(uint32_t) * ((BITSETS_PER_SCRATCH * bitset_words) + TOUCHED_SPARE_ENTRIES) : 0;
  return ((size_t)scratch->capacity * per_ordinal) + ordinal_extras +
         ((size_t)scratch->coverage_capacity * per_covered) + ((size_t)scratch->group_capacity * per_group) +
         ((size_t)scratch->order_capacity * 2 * sizeof(uint32_t)) +
         ((size_t)scratch->selection_capacity * sizeof(double)) + ((size_t)scratch->list_capacity * per_list) +
         remaining_end;
}

static narsil_status reserve_ordinals(keyword_scratch *scratch, uint32_t capacity) {
  if (capacity <= scratch->capacity) { return NARSIL_OK; }
  size_t bitset_words = (size_t)(capacity / BITS_PER_WORD) + 1;
  double *scores = zeroed_allocation(capacity, sizeof *scores);
  int32_t *stamps = zeroed_allocation(capacity, sizeof *stamps);
  uint32_t *touched = allocation((size_t)capacity + TOUCHED_SPARE_ENTRIES, sizeof *touched);
  uint32_t *scorable = allocation(bitset_words, sizeof *scorable);
  uint32_t *seen_bits = allocation(bitset_words, sizeof *seen_bits);
  uint32_t *counted_bits = allocation(bitset_words, sizeof *counted_bits);
  if (scores == NULL || stamps == NULL || touched == NULL || scorable == NULL || seen_bits == NULL ||
      counted_bits == NULL) {
    free(scores);
    free(stamps);
    free(touched);
    free(scorable);
    free(seen_bits);
    free(counted_bits);
    return NARSIL_OUT_OF_MEMORY;
  }
  free(scratch->scores);
  free(scratch->stamps);
  free(scratch->touched);
  free(scratch->scorable);
  free(scratch->seen_bits);
  free(scratch->counted_bits);
  scratch->scores = scores;
  scratch->stamps = stamps;
  scratch->touched = touched;
  scratch->scorable = scorable;
  scratch->seen_bits = seen_bits;
  scratch->counted_bits = counted_bits;
  scratch->capacity = capacity;
  scratch->generation = 0;
  return NARSIL_OK;
}

static narsil_status reserve_coverage(keyword_scratch *scratch, uint32_t capacity) {
  if (capacity <= scratch->coverage_capacity) { return NARSIL_OK; }
  uint32_t *covered = allocation(capacity, sizeof *covered);
  uint32_t *last_term = allocation(capacity, sizeof *last_term);
  if (covered == NULL || last_term == NULL) {
    free(covered);
    free(last_term);
    return NARSIL_OUT_OF_MEMORY;
  }
  free(scratch->covered);
  free(scratch->last_term);
  scratch->covered = covered;
  scratch->last_term = last_term;
  scratch->coverage_capacity = capacity;
  return NARSIL_OK;
}

static narsil_status reserve_groups(keyword_scratch *scratch, uint32_t capacity) {
  if (capacity <= scratch->group_capacity) { return NARSIL_OK; }
  double *best = allocation(capacity, sizeof *best);
  int32_t *stamps = zeroed_allocation(capacity, sizeof *stamps);
  uint32_t *touched = allocation(capacity, sizeof *touched);
  if (best == NULL || stamps == NULL || touched == NULL) {
    free(best);
    free(stamps);
    free(touched);
    return NARSIL_OUT_OF_MEMORY;
  }
  free(scratch->group_best);
  free(scratch->group_stamps);
  free(scratch->group_touched);
  scratch->group_best = best;
  scratch->group_stamps = stamps;
  scratch->group_touched = touched;
  scratch->group_capacity = capacity;
  scratch->group_generation = 0;
  return NARSIL_OK;
}

static narsil_status reserve_order(keyword_scratch *scratch, uint32_t needed) {
  if (needed <= scratch->order_capacity) { return NARSIL_OK; }
  uint32_t capacity = grown_capacity(FIRST_ORDER_CAPACITY, needed);
  uint32_t *order = allocation(capacity, sizeof *order);
  uint32_t *spare = allocation(capacity, sizeof *spare);
  if (order == NULL || spare == NULL) {
    free(order);
    free(spare);
    return NARSIL_OUT_OF_MEMORY;
  }
  free(scratch->order);
  free(scratch->order_spare);
  scratch->order = order;
  scratch->order_spare = spare;
  scratch->order_capacity = capacity;
  return NARSIL_OK;
}

static narsil_status reserve_selection(keyword_scratch *scratch, uint32_t needed) {
  if (needed <= scratch->selection_capacity) { return NARSIL_OK; }
  uint32_t capacity = grown_capacity(FIRST_SELECTION_CAPACITY, needed);
  double *selection = allocation(capacity, sizeof *selection);
  if (selection == NULL) { return NARSIL_OUT_OF_MEMORY; }
  free(scratch->selection);
  scratch->selection = selection;
  scratch->selection_capacity = capacity;
  return NARSIL_OK;
}

static narsil_status reserve_lists(keyword_scratch *scratch, uint32_t needed) {
  if (needed <= scratch->list_capacity) { return NARSIL_OK; }
  uint32_t capacity = grown_capacity(FIRST_LIST_CAPACITY, needed);
  uint32_t *order = allocation(capacity, sizeof *order);
  double *bounds = allocation(capacity, sizeof *bounds);
  double *idfs = allocation(capacity, sizeof *idfs);
  double *remaining = allocation((size_t)capacity + 1, sizeof *remaining);
  if (order == NULL || bounds == NULL || idfs == NULL || remaining == NULL) {
    free(order);
    free(bounds);
    free(idfs);
    free(remaining);
    return NARSIL_OUT_OF_MEMORY;
  }
  free(scratch->list_order);
  free(scratch->list_bounds);
  free(scratch->list_idfs);
  free(scratch->remaining_bounds);
  scratch->list_order = order;
  scratch->list_bounds = bounds;
  scratch->list_idfs = idfs;
  scratch->remaining_bounds = remaining;
  scratch->list_capacity = capacity;
  return NARSIL_OK;
}

narsil_status keyword_reserve(keyword_scratch *scratch, const keyword_needs *needs) {
  narsil_status status = reserve_ordinals(scratch, needs->capacity);
  if (status == NARSIL_OK && needs->coverage) { status = reserve_coverage(scratch, needs->capacity); }
  if (status == NARSIL_OK && needs->groups) { status = reserve_groups(scratch, needs->capacity); }
  if (status == NARSIL_OK) { status = reserve_order(scratch, needs->order); }
  if (status == NARSIL_OK) { status = reserve_selection(scratch, needs->selection); }
  if (status == NARSIL_OK) { status = reserve_lists(scratch, needs->lists); }
  return status;
}

void keyword_begin(keyword_scratch *scratch) {
  if (scratch->generation >= MAX_GENERATION) {
    if (scratch->capacity > 0) { memset(scratch->stamps, 0, (size_t)scratch->capacity * sizeof *scratch->stamps); }
    scratch->generation = 0;
  }
  scratch->generation++;
  scratch->touched_count = 0;
}

void keyword_begin_group(keyword_scratch *scratch) {
  if (scratch->group_generation >= MAX_GENERATION) {
    if (scratch->group_capacity > 0) {
      memset(scratch->group_stamps, 0, (size_t)scratch->group_capacity * sizeof *scratch->group_stamps);
    }
    scratch->group_generation = 0;
  }
  scratch->group_generation++;
  scratch->group_touched_count = 0;
}
