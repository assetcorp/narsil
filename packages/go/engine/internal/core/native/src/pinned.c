#include "../include/narsil_pinned.h"

#include "internal.h"
#include "keyword/scratch.h"
#include "regions.h"

#include "../include/narsil_core.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

typedef struct {
  uint32_t removed;
  uint32_t placed;
  uint32_t needed;
} pinned_counts;

static int valid_request(const narsil_pinned_request *request, const narsil_pinned_output *output) {
  if (request == NULL || output == NULL || request->count > INT32_MAX || request->ranked_count > INT32_MAX ||
      request->ranked_count != request->position_count || request->has_depth > 1) {
    return 0;
  }
  memory_region ranked;
  memory_region positions;
  memory_region entries;
  memory_region count;
  memory_region request_metadata;
  memory_region output_metadata;
  if (!region_of(request->ranked, request->ranked_count, sizeof *request->ranked, &ranked) ||
      !region_of(request->positions, request->position_count, sizeof *request->positions, &positions) ||
      !region_of(output->entries, output->capacity, sizeof *output->entries, &entries) ||
      !region_of(&output->count, 1, sizeof output->count, &count) ||
      !region_of(request, 1, sizeof *request, &request_metadata) ||
      !region_of(output, 1, offsetof(narsil_pinned_output, count), &output_metadata)) {
    return 0;
  }
  return !overlaps(entries, ranked) && !overlaps(entries, positions) && !overlaps(count, entries) &&
         !overlaps(count, ranked) && !overlaps(count, positions) && !overlaps(entries, request_metadata) &&
         !overlaps(count, request_metadata) && !overlaps(entries, output_metadata);
}

static int number_order(const void *left, const void *right) {
  return (*(const double *)left > *(const double *)right) - (*(const double *)left < *(const double *)right);
}

static int before(const narsil_pinned_request *request, uint32_t left, uint32_t right) {
  uint32_t first = request->positions[left];
  uint32_t second = request->positions[right];
  return first == second ? left < right : first < second;
}

static void order_pins(const narsil_pinned_request *request, keyword_scratch *scratch, uint32_t count) {
  for (size_t width = 1; width < count; width *= 2) {
    for (size_t start = 0; start < count; start += width * 2) {
      size_t middle = width < count - start ? start + width : count;
      size_t end = width < count - middle ? middle + width : count;
      size_t left = start;
      size_t right = middle;
      for (size_t at = start; at < end; at++) {
        if (left < middle && (right == end || before(request, scratch->order[left], scratch->order[right]))) {
          scratch->order_spare[at] = scratch->order[left++];
        } else {
          scratch->order_spare[at] = scratch->order[right++];
        }
      }
    }
    for (uint32_t at = 0; at < count; at++) { scratch->order[at] = scratch->order_spare[at]; }
  }
}

static uint32_t select_free(uint32_t rank, const uint32_t *tree, uint32_t length) {
  uint32_t step = 1;
  while (step <= length / 2) { step *= 2; }
  uint32_t prefix = 0;
  for (; step != 0; step /= 2) {
    if (step > length - prefix) { continue; }
    uint32_t next = prefix + step;
    if (tree[next - 1] <= rank) {
      rank -= tree[next - 1];
      prefix = next;
    }
  }
  return prefix;
}

static void fill_entries(const narsil_pinned_request *request, narsil_pinned_output *output, keyword_scratch *scratch,
                         pinned_counts counts) {
  uint32_t removed = counts.removed;
  uint32_t placed = counts.placed;
  uint32_t needed = counts.needed;
  uint32_t *tree = scratch->order_spare;
  for (uint32_t at = 0; at < needed; at++) {
    uint32_t one_based = at + 1;
    tree[at] = one_based & (UINT32_C(0) - one_based);
    output->entries[at] = INT32_MIN;
  }
  uint32_t organic = request->count - removed;
  for (uint32_t remaining = placed; remaining > 0; remaining--) {
    uint32_t pin = scratch->order[remaining - 1];
    uint32_t length = organic + remaining - 1;
    uint32_t rank = request->positions[pin] < length ? request->positions[pin] : length;
    uint32_t slot = select_free(rank, tree, needed);
    output->entries[slot] = -1 - (int32_t)pin;
    for (uint32_t at = slot; at < needed; at |= at + 1) { tree[at]--; }
  }
  uint32_t next = 0;
  uint32_t dropped = 0;
  for (uint32_t at = 0; at < needed; at++) {
    if (output->entries[at] != INT32_MIN) { continue; }
    while (dropped < removed && scratch->selection[dropped] == next) {
      dropped++;
      next++;
    }
    output->entries[at] = (int32_t)next++;
  }
}

narsil_status narsil_place_pinned(narsil_workspace *workspace, const narsil_pinned_request *request,
                                  narsil_pinned_output *output) {
  if (workspace == NULL || !valid_request(request, output)) { return NARSIL_INVALID_ARGUMENT; }
  uint32_t removed = 0;
  uint32_t placed = 0;
  for (size_t pin = 0; pin < request->ranked_count; pin++) {
    int32_t ranked = request->ranked[pin];
    if (ranked < -1 || (ranked >= 0 && (uint32_t)ranked >= request->count)) { return NARSIL_INVALID_ARGUMENT; }
    removed += ranked >= 0;
    placed += request->has_depth == 0 || request->positions[pin] < request->depth;
  }
  if (removed > request->count) { return NARSIL_INVALID_ARGUMENT; }
  uint32_t needed = request->count - removed + placed;
  if (needed > output->capacity) { return NARSIL_NEEDS_ROOM; }
  uint32_t pins = (uint32_t)request->ranked_count;
  uint32_t order = pins > needed ? pins : needed;
  keyword_scratch *scratch = workspace_keyword_scratch(workspace);
  keyword_needs needs = {0, 0, 0, order, removed, 0};
  narsil_status status = keyword_reserve(scratch, &needs);
  if (status != NARSIL_OK) { return status; }
  uint32_t ranked_at = 0;
  uint32_t placed_at = 0;
  for (uint32_t pin = 0; pin < pins; pin++) {
    if (request->ranked[pin] >= 0) { scratch->selection[ranked_at++] = request->ranked[pin]; }
    if (request->has_depth == 0 || request->positions[pin] < request->depth) { scratch->order[placed_at++] = pin; }
  }
  if (removed > 1) {
    qsort(scratch->selection, removed, sizeof *scratch->selection, number_order);
    for (uint32_t at = 1; at < removed; at++) {
      if (scratch->selection[at] == scratch->selection[at - 1]) { return NARSIL_INVALID_ARGUMENT; }
    }
  }
  order_pins(request, scratch, placed);
  pinned_counts counts = {removed, placed, needed};
  fill_entries(request, output, scratch, counts);
  output->count = needed;
  return NARSIL_OK;
}
