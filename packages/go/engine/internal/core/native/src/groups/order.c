#include "scratch.h"

#include "../../include/narsil_groups.h"
#include "../score_order.h"
#include "../stored_values/values.h"

#include <stddef.h>
#include <stdint.h>

static int valid_hit(const narsil_group_request *request, uint32_t position) {
  for (size_t field = 0; field < request->value_count; field++) {
    if (!stored_value_valid(&request->values[field], request->ordinals[position])) { return 0; }
  }
  return 1;
}

static int compare_tuple(const narsil_group_request *request, uint32_t left, uint32_t right) {
  for (size_t field = 0; field < request->value_count; field++) {
    int order = stored_value_compare(&request->values[field], request->ordinals[left], request->ordinals[right]);
    if (order != 0) { return order; }
  }
  return 0;
}

static int before(int groups, const narsil_group_request *request, const group_scratch *scratch, uint32_t left,
                  uint32_t right) {
  if (!groups) {
    int order = compare_tuple(request, left, right);
    return order == 0 ? left <= right : order < 0;
  }
  uint32_t first = scratch->positions[scratch->groups[left].first];
  uint32_t second = scratch->positions[scratch->groups[right].first];
  int order = score_order(request->scores[first], request->scores[second]);
  if (order != 0) { return order < 0; }
  if (request->id_ranks[first] != request->id_ranks[second]) {
    return request->id_ranks[first] < request->id_ranks[second];
  }
  return first <= second;
}

static void order_indices(int groups, const narsil_group_request *request, group_scratch *scratch, uint32_t count) {
  uint32_t *indices = groups ? scratch->order : scratch->positions;
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

uint32_t group_collect(const narsil_group_request *request, group_scratch *scratch) {
  uint32_t count = 0;
  for (uint32_t at = 0; at < request->ordinal_count; at++) {
    if (valid_hit(request, at)) { scratch->positions[count++] = at; }
  }
  order_indices(0, request, scratch, count);
  uint32_t distinct = 0;
  uint32_t first = 0;
  while (first < count) {
    uint32_t end = first + 1;
    while (end < count && compare_tuple(request, scratch->positions[first], scratch->positions[end]) == 0) { end++; }
    hit_group group = {first, end};
    scratch->groups[distinct] = group;
    scratch->order[distinct] = distinct;
    distinct++;
    first = end;
  }
  order_indices(1, request, scratch, distinct);
  return distinct;
}
