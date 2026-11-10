#include "scratch.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_group_merge.h"
#include "../allocation.h"
#include "../internal.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

enum { INDEX_ARRAYS = 5 };

narsil_status group_merge_reserve(group_merge_scratch *scratch, uint32_t groups) {
  if (groups <= scratch->capacity) { return NARSIL_OK; }
  size_t stride = sizeof(merged_group) + (INDEX_ARRAYS * sizeof(uint32_t));
  if (groups > SIZE_MAX / stride) { return NARSIL_INVALID_ARGUMENT; }
  size_t bytes = (size_t)groups * stride;
  void *allocation = core_allocate(bytes);
  if (allocation == NULL) { return NARSIL_OUT_OF_MEMORY; }
  free(scratch->allocation);
  scratch->allocation = allocation;
  scratch->bytes = bytes;
  scratch->capacity = groups;
  scratch->groups = allocation;
  scratch->sources = (uint32_t *)(scratch->groups + groups);
  scratch->spare = scratch->sources + groups;
  scratch->order = scratch->spare + groups;
  scratch->heap = scratch->order + groups;
  scratch->positions = scratch->heap + groups;
  return NARSIL_OK;
}

narsil_status narsil_merge_groups(narsil_workspace *workspace, const narsil_group_merge_request *request,
                                  narsil_group_merge_output *output) {
  if (workspace == NULL || !group_merge_valid(request, output)) { return NARSIL_INVALID_ARGUMENT; }
  if (output->offset_capacity == 0) { return NARSIL_NEEDS_ROOM; }
  if (request->key_count == 0 || (request->has_limit != 0 && request->limit == 0)) {
    output->offsets[0] = 0;
    output->count = 0;
    return NARSIL_OK;
  }
  group_merge_scratch *scratch = workspace_group_merge_scratch(workspace);
  narsil_status status = group_merge_reserve(scratch, (uint32_t)request->key_count);
  if (status != NARSIL_OK) { return status; }
  uint32_t count = group_merge_collect(request, scratch);
  uint32_t retained = request->has_limit != 0 && request->limit < count ? request->limit : count;
  if (retained > output->key_capacity || (size_t)retained + 1 > output->offset_capacity) { return NARSIL_NEEDS_ROOM; }
  size_t entries = 0;
  for (uint32_t at = 0; at < retained; at++) { entries += scratch->groups[scratch->order[at]].retained; }
  if (entries > output->source_capacity || entries > output->index_capacity) { return NARSIL_NEEDS_ROOM; }
  group_merge_write(request, scratch, retained, output);
  output->count = retained;
  return NARSIL_OK;
}
