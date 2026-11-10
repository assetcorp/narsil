#include "scratch.h"

#include "../../include/narsil_group_merge.h"
#include "../regions.h"

#include <stddef.h>
#include <stdint.h>

enum { INPUT_REGIONS = 8, OUTPUT_REGIONS = 5, ID_RANK_REGION = 5, REQUEST_REGION = 6, METADATA_REGION = 7 };

static int valid_regions(const narsil_group_merge_request *request, const narsil_group_merge_output *output) {
  memory_region inputs[INPUT_REGIONS];
  memory_region outputs[OUTPUT_REGIONS];
  if (!region_of(request->keys, request->key_count, sizeof *request->keys, &inputs[0]) ||
      !region_of(request->offsets, request->offset_count, sizeof *request->offsets, &inputs[1]) ||
      !region_of(request->scores, request->score_count, sizeof *request->scores, &inputs[2]) ||
      !region_of(request->score_present, request->score_present_count, sizeof *request->score_present, &inputs[3]) ||
      !region_of(request->ranks, request->rank_count, sizeof *request->ranks, &inputs[4]) ||
      !region_of(request->id_ranks, request->id_rank_count, sizeof *request->id_ranks, &inputs[ID_RANK_REGION]) ||
      !region_of(request, 1, sizeof *request, &inputs[REQUEST_REGION]) ||
      !region_of(output, 1, offsetof(narsil_group_merge_output, count), &inputs[METADATA_REGION]) ||
      !region_of(output->keys, output->key_capacity, sizeof *output->keys, &outputs[0]) ||
      !region_of(output->offsets, output->offset_capacity, sizeof *output->offsets, &outputs[1]) ||
      !region_of(output->sources, output->source_capacity, sizeof *output->sources, &outputs[2]) ||
      !region_of(output->indices, output->index_capacity, sizeof *output->indices, &outputs[3]) ||
      !region_of(&output->count, 1, sizeof output->count, &outputs[4])) {
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

int group_merge_valid(const narsil_group_merge_request *request, const narsil_group_merge_output *output) {
  if (request == NULL || output == NULL || request->key_count > UINT32_MAX || request->key_count == SIZE_MAX ||
      request->offset_count != request->key_count + 1 || request->rank_count > UINT32_MAX ||
      request->id_rank_count != request->rank_count || request->has_scores > 1 || request->has_score_present > 1 ||
      request->sorted > 1 || request->has_limit > 1 || !valid_regions(request, output)) {
    return 0;
  }
  if (request->offsets[0] != 0 || request->offsets[request->key_count] != request->rank_count) { return 0; }
  for (size_t at = 1; at < request->offset_count; at++) {
    if (request->offsets[at] < request->offsets[at - 1]) { return 0; }
  }
  size_t words = (request->rank_count / GROUP_SCORE_WORD_BITS) + (request->rank_count % GROUP_SCORE_WORD_BITS != 0);
  if (words == 0) { words = 1; }
  if (request->has_scores == 0) {
    if (request->score_count != 0 || request->has_score_present != 0 || request->score_present_count != 0) { return 0; }
  } else if (request->score_count != request->rank_count) {
    return 0;
  }
  if (request->has_score_present != 0) {
    if (request->score_present_count < words) { return 0; }
  } else if (request->score_present_count != 0) {
    return 0;
  }
  if (request->sorted == 0) {
    for (size_t at = 0; at < request->rank_count; at++) {
      if (request->ranks[at] != request->id_ranks[at]) { return 0; }
    }
  }
  return 1;
}
