#include "../../include/narsil_group_merge.h"
#include "scratch.h"

#include <stddef.h>
#include <stdint.h>

static int before(const narsil_group_merge_request *request, const group_merge_scratch *scratch, uint32_t left,
                  uint32_t right) {
  if (left == right) { return 0; }
  group_entry_position first = {scratch->positions[left], left};
  group_entry_position second = {scratch->positions[right], right};
  return group_entry_before(request, first, second);
}

static void sift_down(const narsil_group_merge_request *request, group_merge_scratch *scratch, size_t size,
                      size_t parent) {
  uint32_t source = scratch->heap[parent];
  while (parent < size / 2) {
    size_t child = (parent * 2) + 1;
    if (child + 1 < size && before(request, scratch, scratch->heap[child + 1], scratch->heap[child])) { child++; }
    if (!before(request, scratch, scratch->heap[child], source)) { break; }
    scratch->heap[parent] = scratch->heap[child];
    parent = child;
  }
  scratch->heap[parent] = source;
}

void group_merge_write(const narsil_group_merge_request *request, group_merge_scratch *scratch, uint32_t retained,
                       narsil_group_merge_output *output) {
  uint32_t written = 0;
  output->offsets[0] = 0;
  for (uint32_t at = 0; at < retained; at++) {
    const merged_group *group = &scratch->groups[scratch->order[at]];
    size_t size = 0;
    for (uint32_t index = group->first; index < group->end; index++) {
      uint32_t source = scratch->sources[index];
      uint32_t start = request->offsets[source];
      if (start == request->offsets[(size_t)source + 1]) { continue; }
      scratch->heap[size++] = source;
      scratch->positions[source] = start;
    }
    for (size_t parent = size / 2; parent > 0; parent--) { sift_down(request, scratch, size, parent - 1); }
    for (uint32_t entry = 0; entry < group->retained; entry++) {
      uint32_t source = scratch->heap[0];
      uint32_t current = scratch->positions[source];
      output->sources[written] = source;
      output->indices[written++] = current - request->offsets[source];
      scratch->positions[source] = current + 1;
      if (current + 1 == request->offsets[(size_t)source + 1]) { scratch->heap[0] = scratch->heap[--size]; }
      if (size > 0) { sift_down(request, scratch, size, 0); }
    }
    output->keys[at] = group->key;
    output->offsets[(size_t)at + 1] = written;
  }
}
