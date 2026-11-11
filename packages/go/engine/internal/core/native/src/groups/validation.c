#include "scratch.h"

#include "../../include/narsil_groups.h"
#include "../regions.h"
#include "../stored_values/values.h"

#include <stddef.h>
#include <stdint.h>

enum { GROUP_INPUT_REGIONS = 6, GROUP_OUTPUT_REGIONS = 5 };

static int separated(const memory_region *inputs, size_t count, const memory_region outputs[GROUP_OUTPUT_REGIONS]) {
  for (size_t target = 0; target < GROUP_OUTPUT_REGIONS; target++) {
    for (size_t source = 0; source < count; source++) {
      if (overlaps(outputs[target], inputs[source])) { return 0; }
    }
  }
  return 1;
}

static int valid_outputs(const narsil_group_output *output, memory_region outputs[GROUP_OUTPUT_REGIONS]) {
  if (!region_of(output->heads, output->head_capacity, sizeof *output->heads, &outputs[0]) ||
      !region_of(output->offsets, output->offset_capacity, sizeof *output->offsets, &outputs[1]) ||
      !region_of(output->hits, output->hit_capacity, sizeof *output->hits, &outputs[2]) ||
      !region_of(output->members, output->member_capacity, sizeof *output->members, &outputs[3]) ||
      !region_of(&output->count, 1, sizeof output->count, &outputs[4])) {
    return 0;
  }
  for (size_t target = 0; target < GROUP_OUTPUT_REGIONS; target++) {
    for (size_t prior = 0; prior < target; prior++) {
      if (overlaps(outputs[target], outputs[prior])) { return 0; }
    }
  }
  return 1;
}

static int valid_inputs(const narsil_group_request *request, const narsil_group_output *output,
                        const memory_region outputs[GROUP_OUTPUT_REGIONS]) {
  memory_region inputs[GROUP_INPUT_REGIONS];
  enum { OUTPUT_METADATA_REGION = 5 };
  if (!region_of(request, 1, sizeof *request, &inputs[0]) ||
      !region_of(request->values, request->value_count, sizeof *request->values, &inputs[1]) ||
      !region_of(request->ordinals, request->ordinal_count, sizeof *request->ordinals, &inputs[2]) ||
      !region_of(request->scores, request->score_count, sizeof *request->scores, &inputs[3]) ||
      !region_of(request->id_ranks, request->id_rank_count, sizeof *request->id_ranks, &inputs[4]) ||
      !region_of(output, 1, offsetof(narsil_group_output, count), &inputs[OUTPUT_METADATA_REGION])) {
    return 0;
  }
  if (!separated(inputs, GROUP_INPUT_REGIONS, outputs)) { return 0; }
  for (size_t field = 0; field < request->value_count; field++) {
    memory_region regions[STORED_VALUE_REGIONS];
    if (!stored_value_regions(&request->values[field], regions) || !separated(regions, STORED_VALUE_REGIONS, outputs)) {
      return 0;
    }
  }
  return 1;
}

int group_request_valid(const narsil_group_request *request, const narsil_group_output *output) {
  if (request == NULL || output == NULL || request->ordinal_count > UINT32_MAX ||
      request->score_count != request->ordinal_count || request->id_rank_count != request->ordinal_count ||
      request->value_count > UINT32_MAX || request->has_limit > 1) {
    return 0;
  }
  memory_region outputs[GROUP_OUTPUT_REGIONS];
  return valid_outputs(output, outputs) && valid_inputs(request, output, outputs);
}
