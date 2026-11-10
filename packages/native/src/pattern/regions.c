#include "internal.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_pattern.h"
#include "../../include/narsil_stored_values.h"
#include "../../include/narsil_work.h"
#include "../regions.h"
#include "../stored_values/values.h"
#include "../work/tally.h"
#include "constants.h"

#include <stddef.h>
#include <stdint.h>

typedef struct {
  memory_region output;
  memory_region spent;
} pattern_outputs;

static int avoids_outputs(memory_region input, const pattern_outputs *outputs) {
  return !overlaps(input, outputs->output) && !overlaps(input, outputs->spent);
}

static int descriptor_valid(const void *pointer, size_t width, size_t alignment) {
  memory_region region;
  return (uintptr_t)pointer % alignment == 0 && region_of(pointer, 1, width, &region);
}

static int input_valid(const void *data, size_t count, size_t width, const pattern_outputs *outputs) {
  memory_region input;
  return count <= UINT32_MAX && (uintptr_t)data % width == 0 && region_of(data, count, width, &input) &&
         avoids_outputs(input, outputs);
}

static int metadata_valid(const pattern_request *request, const pattern_outputs *outputs) {
  const void *pointers[] = {request->index, request->values, request->test, request->meter};
  const size_t widths[] = {sizeof *request->index, sizeof *request->values, sizeof *request->test,
                           sizeof *request->meter};
  for (size_t at = 0; at < sizeof pointers / sizeof pointers[0]; at++) {
    memory_region region;
    if (!region_of(pointers[at], 1, widths[at], &region) || !avoids_outputs(region, outputs)) { return 0; }
  }
  return 1;
}

static int values_valid(const narsil_stored_values *values, const pattern_outputs *outputs) {
  memory_region regions[STORED_VALUE_REGIONS];
  static const size_t widths[STORED_VALUE_REGIONS] = {1, 4, 1, 8, 4, 4, 2, 1};
  if (!stored_value_regions(values, regions)) { return 0; }
  for (size_t at = 0; at < STORED_VALUE_REGIONS; at++) {
    if (regions[at].start % widths[at] != 0 || !avoids_outputs(regions[at], outputs)) { return 0; }
  }
  return 1;
}

static int index_valid(const narsil_pattern_index *index, const pattern_outputs *outputs) {
  if (index->runs.count % PATTERN_RUN_POINTS != 0 ||
      index->offsets.count != (index->runs.count / PATTERN_RUN_POINTS) + 1) {
    return 0;
  }
  const narsil_pattern_list *lists[] = {&index->documents, &index->runs, &index->offsets, &index->postings};
  for (size_t at = 0; at < sizeof lists / sizeof lists[0]; at++) {
    if (!input_valid(lists[at]->values, lists[at]->count, sizeof(uint32_t), outputs)) { return 0; }
  }
  return 1;
}

narsil_status pattern_regions_valid(const pattern_request *request) {
  if (!descriptor_valid(request->index, sizeof *request->index, _Alignof(narsil_pattern_index)) ||
      !descriptor_valid(request->values, sizeof *request->values, _Alignof(narsil_stored_values)) ||
      !descriptor_valid(request->test, sizeof *request->test, _Alignof(narsil_pattern_test)) ||
      !descriptor_valid(request->meter, sizeof *request->meter, _Alignof(narsil_work_meter))) {
    return NARSIL_INVALID_ARGUMENT;
  }
  pattern_outputs outputs;
  if ((uintptr_t)request->into % _Alignof(uint32_t) != 0 || request->into_words > UINT32_MAX ||
      !region_of(request->into, request->into_words, sizeof *request->into, &outputs.output) ||
      !work_meter_valid(request->meter) ||
      !region_of(request->meter->spent, 1, sizeof *request->meter->spent, &outputs.spent) ||
      overlaps(outputs.output, outputs.spent) || !metadata_valid(request, &outputs) ||
      !input_valid(request->meter->stop, 1, sizeof *request->meter->stop, &outputs) ||
      !index_valid(request->index, &outputs) || !values_valid(request->values, &outputs)) {
    return NARSIL_INVALID_ARGUMENT;
  }
  const narsil_pattern_test *test = request->test;
  if (test->operator_kind > NARSIL_PATTERN_REGEX || test->case_fold > 1 || test->count_preparation > 1 ||
      test->tolerance > PATTERN_AUTO_TOLERANCE || (test->tolerance != 0 && test->operator_kind != NARSIL_PATTERN_EQ) ||
      test->length > (size_t)PATTERN_MAX_TEXT_POINTS * 2 ||
      !input_valid(test->text, test->length, sizeof *test->text, &outputs)) {
    return NARSIL_INVALID_ARGUMENT;
  }
  size_t words = (request->values->shape_count / PATTERN_WORD_BITS) +
                 (size_t)(request->values->shape_count % PATTERN_WORD_BITS != 0);
  if (words == 0) { words = 1; }
  return request->into_words < words ? NARSIL_NEEDS_ROOM : NARSIL_OK;
}
