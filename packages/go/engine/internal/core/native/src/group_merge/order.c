#include "scratch.h"

#include "../../include/narsil_group_merge.h"
#include "../score_order.h"

#include <math.h>
#include <stddef.h>
#include <stdint.h>

double group_entry_score(double absent, const narsil_group_merge_request *request, uint32_t entry) {
  if (request->has_scores == 0 ||
      (request->has_score_present != 0 && (request->score_present[entry / GROUP_SCORE_WORD_BITS] &
                                           (UINT32_C(1) << (entry % GROUP_SCORE_WORD_BITS))) == 0)) {
    return absent;
  }
  return request->scores[entry];
}

int group_entry_before(const narsil_group_merge_request *request, group_entry_position left,
                       group_entry_position right) {
  if (request->sorted == 0) {
    int order = score_order(group_entry_score(-HUGE_VAL, request, left.index),
                            group_entry_score(-HUGE_VAL, request, right.index));
    if (order != 0) { return order < 0; }
  }
  uint32_t left_rank = request->ranks[left.index];
  uint32_t right_rank = request->ranks[right.index];
  return left_rank == right_rank ? left.source < right.source : left_rank < right_rank;
}

static int before(int groups, const narsil_group_merge_request *request, const group_merge_scratch *scratch,
                  uint32_t left, uint32_t right) {
  if (!groups) {
    uint32_t left_key = request->keys[left];
    uint32_t right_key = request->keys[right];
    return left_key == right_key ? left <= right : left_key < right_key;
  }
  const merged_group *first = &scratch->groups[left];
  const merged_group *second = &scratch->groups[right];
  int score = score_order(first->score, second->score);
  if (score != 0) { return score < 0; }
  if ((first->retained == 0) != (second->retained == 0)) { return first->retained == 0; }
  if (first->id_rank != second->id_rank) { return first->id_rank < second->id_rank; }
  return first->source <= second->source;
}

static void order_indices(int groups, const narsil_group_merge_request *request, group_merge_scratch *scratch,
                          uint32_t count) {
  uint32_t *indices = groups ? scratch->order : scratch->sources;
  for (uint32_t at = 0; at < count; at++) { indices[at] = at; }
  for (size_t width = 1; width < count;) {
    for (size_t start = 0; start < count;) {
      size_t middle = width < count - start ? start + width : count;
      size_t end = width < count - middle ? middle + width : count;
      size_t left = start;
      size_t right = middle;
      for (size_t at = start; at < end; at++) {
        if (left < middle && (right == end || before(groups, request, scratch, indices[left], indices[right]))) {
          scratch->spare[at] = indices[left++];
        } else {
          scratch->spare[at] = indices[right++];
        }
      }
      start = end;
    }
    for (uint32_t at = 0; at < count; at++) { indices[at] = scratch->spare[at]; }
    if (width >= count - width) { break; }
    width *= 2;
  }
}

uint32_t group_merge_collect(const narsil_group_merge_request *request, group_merge_scratch *scratch) {
  order_indices(0, request, scratch, (uint32_t)request->key_count);
  uint32_t distinct = 0;
  size_t first = 0;
  while (first < request->key_count) {
    uint32_t first_source = scratch->sources[first];
    uint32_t key = request->keys[first_source];
    size_t end = first;
    uint32_t total = 0;
    group_entry_position head = {0};
    int has_head = 0;
    while (end < request->key_count && request->keys[scratch->sources[end]] == key) {
      uint32_t source = scratch->sources[end++];
      uint32_t start = request->offsets[source];
      uint32_t count = request->offsets[(size_t)source + 1] - start;
      total += count;
      group_entry_position candidate = {start, source};
      if (request->max_per_group > 0 && count > 0 && (!has_head || group_entry_before(request, candidate, head))) {
        head = candidate;
        has_head = 1;
      }
    }
    merged_group group = {
        has_head ? group_entry_score(0, request, head.index) : 0,
        key,
        (uint32_t)first,
        (uint32_t)end,
        first_source,
        total < request->max_per_group ? total : request->max_per_group,
        has_head ? request->id_ranks[head.index] : 0,
    };
    scratch->groups[distinct++] = group;
    first = end;
  }
  order_indices(1, request, scratch, distinct);
  return distinct;
}
