#include "../../include/narsil_sort_select.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_sort_order.h"
#include "scratch.h"
#include "select.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

static int accepted(const narsil_sort_select_request *request, uint32_t ordinal) {
  return sort_marked(request->live, ordinal) && sort_marked(request->filter, ordinal);
}

static narsil_status append(const narsil_sort_select_request *request, uint32_t ordinal, uint32_t *ordinals,
                            uint32_t *count) {
  if (!accepted(request, ordinal)) { return NARSIL_OK; }
  if (!sort_select_ordinal_valid(request, ordinal)) { return NARSIL_INVALID_ARGUMENT; }
  if (sort_select_anchor_compare(request, ordinal) >= 0) {
    if (*count >= request->columns[0].current.count) { return NARSIL_INVALID_ARGUMENT; }
    ordinals[(*count)++] = ordinal;
  }
  return NARSIL_OK;
}

static narsil_status collect_dirty(const narsil_sort_select_request *request, uint32_t *ordinals, uint32_t *count) {
  const narsil_sort_column *leading = &request->columns[0];
  size_t words = leading->current.count == 0 ? 1 : ((leading->current.count - 1) / SORT_WORD_BITS) + 1;
  for (size_t word = 0; word < words; word++) {
    uint32_t dirty = leading->dirty[word] & request->live[word] & request->filter[word];
    while (dirty != 0) {
      uint32_t bit = (uint32_t)__builtin_ctz(dirty);
      dirty &= dirty - 1;
      size_t ordinal = (word * SORT_WORD_BITS) + bit;
      if (ordinal >= leading->current.count) { continue; }
      narsil_status status = append(request, (uint32_t)ordinal, ordinals, count);
      if (status != NARSIL_OK) { return status; }
    }
  }
  return NARSIL_OK;
}

static narsil_status collect_built(uint32_t *clean, const narsil_sort_select_request *request, uint32_t *ordinals,
                                   uint32_t *count) {
  const narsil_sort_column *leading = &request->columns[0];
  int32_t last_rank = -1;
  size_t start = sort_select_start(request);
  if (start == SIZE_MAX) { return NARSIL_INVALID_ARGUMENT; }
  for (size_t at = start; at < leading->ordered_count; at++) {
    size_t position = request->directions[0] ? leading->ordered_count - at - 1 : at;
    uint32_t ordinal = leading->ordered[position];
    if (ordinal >= leading->current.count || ordinal >= leading->rank_count) { return NARSIL_INVALID_ARGUMENT; }
    if (sort_marked(leading->dirty, ordinal) || !accepted(request, ordinal)) { continue; }
    int32_t rank = leading->ranks[ordinal];
    if (rank < 2 || (rank & 1) != 0 || (uint32_t)rank / 2 > leading->values.count) { return NARSIL_INVALID_ARGUMENT; }
    if (*clean >= request->limit && rank != last_rank) { break; }
    uint32_t before = *count;
    narsil_status status = append(request, ordinal, ordinals, count);
    if (status != NARSIL_OK) { return status; }
    if (*count != before) {
      (*clean)++;
      last_rank = rank;
    }
  }
  return NARSIL_OK;
}

static narsil_status collect_missing(const narsil_sort_select_request *request, uint32_t *ordinals, uint32_t *count) {
  const narsil_sort_column *leading = &request->columns[0];
  size_t words = leading->current.count == 0 ? 1 : ((leading->current.count - 1) / SORT_WORD_BITS) + 1;
  for (size_t word = 0; word < words; word++) {
    uint32_t pending = request->live[word] & request->filter[word] & ~leading->dirty[word];
    while (pending != 0) {
      uint32_t bit = (uint32_t)__builtin_ctz(pending);
      pending &= pending - 1;
      size_t ordinal = (word * SORT_WORD_BITS) + bit;
      if (ordinal >= leading->current.count || (ordinal < leading->rank_count && leading->ranks[ordinal] != -1)) {
        continue;
      }
      narsil_status status = append(request, (uint32_t)ordinal, ordinals, count);
      if (status != NARSIL_OK) { return status; }
    }
  }
  return NARSIL_OK;
}

static narsil_status collect(const narsil_sort_select_request *request, uint32_t *ordinals, uint32_t *count) {
  narsil_status status = collect_dirty(request, ordinals, count);
  if (status != NARSIL_OK) { return status; }
  uint32_t clean = 0;
  status = collect_built(&clean, request, ordinals, count);
  if (status != NARSIL_OK || clean >= request->limit) { return status; }
  return collect_missing(request, ordinals, count);
}

static void order(const narsil_sort_select_request *request, uint32_t *ordinals, uint32_t *spare, size_t count) {
  for (size_t width = 1; width < count;) {
    for (size_t start = 0; start < count;) {
      size_t middle = count - start < width ? count : start + width;
      size_t end = count - middle < width ? count : middle + width;
      size_t left = start;
      size_t right = middle;
      for (size_t at = start; at < end; at++) {
        if (left < middle && (right == end || sort_select_compare(request, ordinals[left], ordinals[right]) <= 0)) {
          spare[at] = ordinals[left++];
        } else {
          spare[at] = ordinals[right++];
        }
      }
      start = end;
    }
    memcpy(ordinals, spare, count * sizeof *ordinals);
    if (width > count / 2) { break; }
    width *= 2;
  }
}

narsil_status narsil_sort_select(narsil_workspace *workspace, const narsil_sort_select_request *request,
                                 uint32_t *count) {
  if (workspace == NULL || !sort_select_valid(request, count)) { return NARSIL_INVALID_ARGUMENT; }
  uint32_t capacity = (uint32_t)request->columns[0].current.count;
  if (request->limit == 0 || capacity == 0) {
    *count = 0;
    return NARSIL_OK;
  }
  sort_order_scratch *scratch = sort_order_workspace(workspace);
  narsil_status status = reserve_sort_order(scratch, capacity);
  if (status != NARSIL_OK) { return status; }
  uint32_t collected = 0;
  status = collect(request, scratch->allocation, &collected);
  if (status != NARSIL_OK) { return status; }
  if (collected > 1) { order(request, scratch->allocation, scratch->allocation + scratch->capacity, collected); }
  uint32_t kept = request->limit < collected ? request->limit : collected;
  while (kept < collected &&
         sort_select_compare(request, scratch->allocation[kept - 1], scratch->allocation[kept]) == 0) {
    kept++;
  }
  if (kept > request->output_capacity) { return NARSIL_NEEDS_ROOM; }
  if (kept > 0) { memcpy(request->output, scratch->allocation, (size_t)kept * sizeof *request->output); }
  *count = kept;
  return NARSIL_OK;
}
