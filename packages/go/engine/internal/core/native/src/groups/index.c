#include "scratch.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_groups.h"
#include "../allocation.h"
#include "../internal.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

enum { GROUP_INDEX_ARRAYS = 3 };

static narsil_status reserve(group_scratch *scratch, uint32_t count) {
  if (count <= scratch->capacity) { return NARSIL_OK; }
  size_t stride = sizeof(hit_group) + (GROUP_INDEX_ARRAYS * sizeof(uint32_t));
  if (count > SIZE_MAX / stride) { return NARSIL_INVALID_ARGUMENT; }
  size_t bytes = (size_t)count * stride;
  void *allocation = core_allocate(bytes);
  if (allocation == NULL) { return NARSIL_OUT_OF_MEMORY; }
  free(scratch->allocation);
  scratch->allocation = allocation;
  scratch->bytes = bytes;
  scratch->capacity = count;
  scratch->groups = allocation;
  scratch->positions = (uint32_t *)(scratch->groups + count);
  scratch->spare = scratch->positions + count;
  scratch->order = scratch->spare + count;
  return NARSIL_OK;
}

static uint32_t retained_members(hit_group group, uint32_t maximum) {
  uint32_t count = group.end - group.first;
  return count < maximum ? count : maximum;
}

static void write_groups(const narsil_group_request *request, const group_scratch *scratch, uint32_t count,
                         narsil_group_output *output) {
  uint32_t position = 0;
  output->offsets[0] = 0;
  for (uint32_t at = 0; at < count; at++) {
    hit_group group = scratch->groups[scratch->order[at]];
    uint32_t retained = retained_members(group, request->max_per_group);
    output->heads[at] = scratch->positions[group.first];
    output->members[at] = group.end - group.first;
    for (uint32_t member = 0; member < retained; member++) {
      output->hits[position++] = scratch->positions[group.first + member];
    }
    output->offsets[(size_t)at + 1] = position;
  }
  output->count = count;
}

narsil_status narsil_group_hits(narsil_workspace *workspace, const narsil_group_request *request,
                                narsil_group_output *output) {
  if (workspace == NULL || !group_request_valid(request, output)) { return NARSIL_INVALID_ARGUMENT; }
  group_scratch *scratch = workspace_group_scratch(workspace);
  narsil_status status = reserve(scratch, (uint32_t)request->ordinal_count);
  if (status != NARSIL_OK) { return status; }
  uint32_t count = group_collect(request, scratch);
  if (request->has_limit != 0 && count > request->limit) { count = request->limit; }
  size_t offset_words = count;
  if (offset_words == SIZE_MAX || count > output->head_capacity || count > output->member_capacity ||
      offset_words + 1 > output->offset_capacity) {
    return NARSIL_NEEDS_ROOM;
  }
  size_t entries = 0;
  for (uint32_t at = 0; at < count; at++) {
    entries += retained_members(scratch->groups[scratch->order[at]], request->max_per_group);
  }
  if (entries > output->hit_capacity) { return NARSIL_NEEDS_ROOM; }
  write_groups(request, scratch, count, output);
  return NARSIL_OK;
}
