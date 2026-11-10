#include "../include/narsil_merges.h"

#include "internal.h"
#include "keyword/scratch.h"
#include "regions.h"
#include "score_order.h"

#include "../include/narsil_core.h"

#include <stddef.h>
#include <stdint.h>

static int valid_regions(const narsil_merge_request *request, const narsil_merge_output *output, int scored) {
  memory_region offsets;
  memory_region scores;
  memory_region ranks;
  memory_region lists;
  memory_region indices;
  memory_region count;
  memory_region request_metadata;
  memory_region output_metadata;
  if (!region_of(request->offsets, request->offset_count, sizeof *request->offsets, &offsets) ||
      !region_of(request->scores, scored ? request->score_count : 0, sizeof *request->scores, &scores) ||
      !region_of(request->ranks, request->rank_count, sizeof *request->ranks, &ranks) ||
      !region_of(output->lists, output->list_capacity, sizeof *output->lists, &lists) ||
      !region_of(output->indices, output->index_capacity, sizeof *output->indices, &indices) ||
      !region_of(&output->count, 1, sizeof output->count, &count) ||
      !region_of(request, 1, sizeof *request, &request_metadata) ||
      !region_of(output, 1, offsetof(narsil_merge_output, count), &output_metadata)) {
    return 0;
  }
  return !overlaps(lists, indices) && !overlaps(lists, offsets) && !overlaps(lists, scores) &&
         !overlaps(lists, ranks) && !overlaps(indices, offsets) && !overlaps(indices, scores) &&
         !overlaps(indices, ranks) && !overlaps(count, lists) && !overlaps(count, indices) &&
         !overlaps(count, offsets) && !overlaps(count, scores) && !overlaps(count, ranks) &&
         !overlaps(lists, request_metadata) && !overlaps(indices, request_metadata) &&
         !overlaps(count, request_metadata) && !overlaps(lists, output_metadata) && !overlaps(indices, output_metadata);
}

static int valid_request(const narsil_merge_request *request, const narsil_merge_output *output, int scored) {
  if (request == NULL || output == NULL || request->offset_count == 0 || request->offset_count - 1 > UINT32_MAX ||
      !valid_regions(request, output, scored)) {
    return 0;
  }
  if (request->offsets[0] != 0) { return 0; }
  for (size_t position = 1; position < request->offset_count; position++) {
    if (request->offsets[position] < request->offsets[position - 1]) { return 0; }
  }
  uint32_t entries = request->offsets[request->offset_count - 1];
  return request->rank_count == entries && (!scored || request->score_count == entries);
}

static int before(int scored, const narsil_merge_request *request, const uint32_t *positions, uint32_t left,
                  uint32_t right) {
  uint32_t left_at = positions[left];
  uint32_t right_at = positions[right];
  if (scored) {
    int order = score_order(request->scores[left_at], request->scores[right_at]);
    if (order != 0) { return order < 0; }
  }
  uint32_t left_rank = request->ranks[left_at];
  uint32_t right_rank = request->ranks[right_at];
  return left_rank == right_rank ? left < right : left_rank < right_rank;
}

static void sift_down(int scored, const narsil_merge_request *request, keyword_scratch *scratch, size_t size,
                      size_t parent) {
  uint32_t *heap = scratch->order;
  uint32_t source = heap[parent];
  while (parent < size / 2) {
    size_t child = (parent * 2) + 1;
    if (child + 1 < size && before(scored, request, scratch->order_spare, heap[child + 1], heap[child])) { child++; }
    if (!before(scored, request, scratch->order_spare, heap[child], source)) { break; }
    heap[parent] = heap[child];
    parent = child;
  }
  heap[parent] = source;
}

static narsil_status merge(narsil_workspace *workspace, const narsil_merge_request *request,
                           narsil_merge_output *output, int scored) {
  if (workspace == NULL || !valid_request(request, output, scored)) { return NARSIL_INVALID_ARGUMENT; }
  uint32_t entries = (uint32_t)request->rank_count;
  uint32_t needed = request->limit < entries ? request->limit : entries;
  if (needed > output->list_capacity || needed > output->index_capacity) { return NARSIL_NEEDS_ROOM; }
  if (needed == 0) {
    output->count = 0;
    return NARSIL_OK;
  }
  uint32_t list_count = (uint32_t)(request->offset_count - 1);
  keyword_scratch *scratch = workspace_keyword_scratch(workspace);
  keyword_needs needs = {0, 0, 0, list_count, 0, 0};
  narsil_status status = keyword_reserve(scratch, &needs);
  if (status != NARSIL_OK) { return status; }
  size_t size = 0;
  for (uint32_t source = 0; source < list_count; source++) {
    uint32_t start = request->offsets[source];
    if (start == request->offsets[(size_t)source + 1]) { continue; }
    scratch->order[size++] = source;
    scratch->order_spare[source] = start;
  }
  for (size_t parent = size / 2; parent > 0; parent--) { sift_down(scored, request, scratch, size, parent - 1); }
  for (uint32_t position = 0; position < needed; position++) {
    uint32_t source = scratch->order[0];
    uint32_t current = scratch->order_spare[source];
    output->lists[position] = source;
    output->indices[position] = current - request->offsets[source];
    scratch->order_spare[source] = current + 1;
    if (current + 1 == request->offsets[(size_t)source + 1]) { scratch->order[0] = scratch->order[--size]; }
    if (size > 0) { sift_down(scored, request, scratch, size, 0); }
  }
  output->count = needed;
  return NARSIL_OK;
}

narsil_status narsil_merge_rankings(narsil_workspace *workspace, const narsil_merge_request *request,
                                    narsil_merge_output *output) {
  return merge(workspace, request, output, 1);
}

narsil_status narsil_merge_sorted(narsil_workspace *workspace, const narsil_merge_request *request,
                                  narsil_merge_output *output) {
  return merge(workspace, request, output, 0);
}
