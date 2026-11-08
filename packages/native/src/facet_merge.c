#include "../include/narsil_facet_merge.h"

#include "../include/narsil_core.h"
#include "internal.h"
#include "keyword/scratch.h"
#include "regions.h"

#include <stddef.h>
#include <stdint.h>

enum { INPUT_REGIONS = 7, OUTPUT_REGIONS = 4, REQUEST_REGION = 5, METADATA_REGION = 6 };

static int valid_regions(const narsil_facet_merge_request *request, const narsil_facet_merge_output *output) {
  memory_region inputs[INPUT_REGIONS];
  memory_region outputs[OUTPUT_REGIONS];
  if (!region_of(request->offsets, request->offset_count, sizeof *request->offsets, &inputs[0]) ||
      !region_of(request->values, request->value_count, sizeof *request->values, &inputs[1]) ||
      !region_of(request->counts, request->count_count, sizeof *request->counts, &inputs[2]) ||
      !region_of(request->bounds, request->bound_count, sizeof *request->bounds, &inputs[3]) ||
      !region_of(request->ranks, request->rank_count, sizeof *request->ranks, &inputs[4]) ||
      !region_of(request, 1, sizeof *request, &inputs[REQUEST_REGION]) ||
      !region_of(output, 1, offsetof(narsil_facet_merge_output, count), &inputs[METADATA_REGION]) ||
      !region_of(output->values, output->value_capacity, sizeof *output->values, &outputs[0]) ||
      !region_of(output->counts, output->count_capacity, sizeof *output->counts, &outputs[1]) ||
      !region_of(output->bound, output->bound_capacity, sizeof *output->bound, &outputs[2]) ||
      !region_of(&output->count, 1, sizeof output->count, &outputs[3])) {
    return 0;
  }
  for (size_t target = 0; target < OUTPUT_REGIONS; target++) {
    for (size_t source = 0; source < INPUT_REGIONS; source++) {
      if (overlaps(outputs[target], inputs[source])) { return 0; }
    }
    for (size_t prior = 0; prior < target; prior++) {
      if (overlaps(outputs[target], outputs[prior])) { return 0; }
    }
  }
  return 1;
}

static int valid_request(const narsil_facet_merge_request *request, const narsil_facet_merge_output *output) {
  if (request == NULL || output == NULL || request->offset_count == 0 || request->offset_count - 1 > UINT32_MAX ||
      request->value_count > UINT32_MAX || request->count_count != request->value_count ||
      request->bound_count != request->offset_count - 1 || request->rank_count > UINT32_MAX || request->ascending > 1 ||
      request->has_limit > 1 || !valid_regions(request, output)) {
    return 0;
  }
  if (request->offsets[0] != 0 || request->offsets[request->offset_count - 1] != request->value_count) { return 0; }
  for (size_t at = 1; at < request->offset_count; at++) {
    if (request->offsets[at] < request->offsets[at - 1]) { return 0; }
  }
  for (size_t at = 0; at < request->value_count; at++) {
    if (request->values[at] >= request->rank_count) { return 0; }
  }
  return 1;
}

static int before(const narsil_facet_merge_request *request, const keyword_scratch *scratch, uint32_t left,
                  uint32_t right) {
  double first = scratch->selection[left];
  double second = scratch->selection[right];
  if (first != second) { return request->ascending != 0 ? first < second : first > second; }
  return request->ranks[left] <= request->ranks[right];
}

static void order_values(const narsil_facet_merge_request *request, keyword_scratch *scratch, uint32_t count) {
  for (size_t width = 1; width < count;) {
    for (size_t start = 0; start < count;) {
      size_t middle = width < count - start ? start + width : count;
      size_t end = width < count - middle ? middle + width : count;
      size_t left = start;
      size_t right = middle;
      for (size_t at = start; at < end; at++) {
        if (left < middle && (right == end || before(request, scratch, scratch->order[left], scratch->order[right]))) {
          scratch->order_spare[at] = scratch->order[left++];
        } else {
          scratch->order_spare[at] = scratch->order[right++];
        }
      }
      start = end;
    }
    for (uint32_t at = 0; at < count; at++) { scratch->order[at] = scratch->order_spare[at]; }
    if (width >= count - width) { break; }
    width *= 2;
  }
}

static narsil_status collect(const narsil_facet_merge_request *request, keyword_scratch *scratch, uint32_t *distinct) {
  for (size_t key = 0; key < request->rank_count; key++) { scratch->selection[key] = -1; }
  uint32_t found = 0;
  for (size_t at = 0; at < request->value_count; at++) {
    uint32_t key = request->values[at];
    double total = scratch->selection[key];
    if (total < 0) {
      scratch->order[found++] = key;
      total = 0;
    }
    if (request->counts[at] > UINT32_MAX - (uint32_t)total) { return NARSIL_INVALID_ARGUMENT; }
    scratch->selection[key] = total + request->counts[at];
  }
  *distinct = found;
  return NARSIL_OK;
}

narsil_status narsil_merge_facets(narsil_workspace *workspace, const narsil_facet_merge_request *request,
                                  narsil_facet_merge_output *output) {
  if (workspace == NULL || !valid_request(request, output)) { return NARSIL_INVALID_ARGUMENT; }
  if (output->bound_capacity == 0) { return NARSIL_NEEDS_ROOM; }
  uint32_t bound = 0;
  for (size_t at = 0; at < request->bound_count; at++) {
    if (request->bounds[at] > UINT32_MAX - bound) { return NARSIL_INVALID_ARGUMENT; }
    bound += request->bounds[at];
  }
  keyword_scratch *scratch = workspace_keyword_scratch(workspace);
  uint32_t keys = (uint32_t)request->rank_count;
  keyword_needs needs = {0, 0, 0, keys, keys, 0};
  narsil_status status = keyword_reserve(scratch, &needs);
  if (status != NARSIL_OK) { return status; }
  uint32_t distinct = 0;
  status = collect(request, scratch, &distinct);
  if (status != NARSIL_OK) { return status; }
  uint32_t kept = request->has_limit != 0 && request->limit < distinct ? request->limit : distinct;
  if (kept > output->value_capacity || kept > output->count_capacity) { return NARSIL_NEEDS_ROOM; }
  order_values(request, scratch, distinct);
  uint32_t largest = 0;
  for (uint32_t at = kept; at < distinct; at++) {
    uint32_t count = (uint32_t)scratch->selection[scratch->order[at]];
    if (count > largest) { largest = count; }
  }
  if (largest > UINT32_MAX - bound) { return NARSIL_INVALID_ARGUMENT; }
  for (uint32_t at = 0; at < kept; at++) {
    uint32_t key = scratch->order[at];
    output->values[at] = key;
    output->counts[at] = (uint32_t)scratch->selection[key];
  }
  output->bound[0] = bound + largest;
  output->count = kept;
  return NARSIL_OK;
}
