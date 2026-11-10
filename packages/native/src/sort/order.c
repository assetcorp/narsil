#include "../../include/narsil_sort_order.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_sort.h"
#include "../allocation.h"
#include "../internal.h"
#include "../regions.h"
#include "scratch.h"
#include "values.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

enum {
  RANK_REGION = SORT_VALUE_REGIONS,
  ORDERED_REGION,
  DIRTY_REGION,
  COUNT_REGION,
  DESCRIPTOR_REGION,
  OUTPUT_REGIONS
};
enum { INPUT_REGIONS = SORT_VALUE_REGIONS + 2, BITMAP_WORD_SHIFT = 5, BITMAP_WORD_BITS = 32, BITMAP_WORD_MASK = 31 };

static int live_at(const uint32_t *live, uint32_t ordinal) {
  return (live[ordinal >> BITMAP_WORD_SHIFT] & (UINT32_C(1) << (ordinal & BITMAP_WORD_MASK))) != 0;
}

static int regions_valid(const narsil_sort_values *current, const uint32_t *live, size_t live_words,
                         const narsil_sort_order_output *output) {
  memory_region inputs[INPUT_REGIONS];
  memory_region outputs[OUTPUT_REGIONS];
  const narsil_sort_values_output *values = &output->values;
  if (!sort_value_regions(current, inputs) || !region_of(live, live_words, sizeof *live, &inputs[SORT_VALUE_REGIONS]) ||
      !region_of(current, 1, sizeof *current, &inputs[SORT_VALUE_REGIONS + 1]) ||
      !region_of(values->kinds, values->capacity, sizeof *values->kinds, &outputs[0]) ||
      !region_of(values->numbers, values->number_capacity, sizeof *values->numbers, &outputs[1]) ||
      !region_of(values->text_start, values->text_start_capacity, sizeof *values->text_start, &outputs[2]) ||
      !region_of(values->text_length, values->text_length_capacity, sizeof *values->text_length, &outputs[3]) ||
      !region_of(values->units, values->unit_capacity, sizeof *values->units, &outputs[4]) ||
      !region_of(output->ranks, output->rank_capacity, sizeof *output->ranks, &outputs[RANK_REGION]) ||
      !region_of(output->ordered, output->ordered_capacity, sizeof *output->ordered, &outputs[ORDERED_REGION]) ||
      !region_of(output->dirty, output->dirty_capacity, sizeof *output->dirty, &outputs[DIRTY_REGION]) ||
      !region_of(output->counts, output->count_capacity, sizeof *output->counts, &outputs[COUNT_REGION]) ||
      !region_of(output, 1, sizeof *output, &outputs[DESCRIPTOR_REGION])) {
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

narsil_status reserve_sort_order(sort_order_scratch *scratch, uint32_t count) {
  if (count <= scratch->capacity) { return NARSIL_OK; }
  size_t capacity = grown_capacity(scratch->capacity == 0 ? 1 : scratch->capacity, count);
  if (capacity > UINT32_MAX || capacity > SIZE_MAX / (2 * sizeof(uint32_t))) { return NARSIL_INVALID_ARGUMENT; }
  size_t bytes = capacity * 2 * sizeof(uint32_t);
  uint32_t *allocation = core_allocate(bytes);
  if (allocation == NULL) { return NARSIL_OUT_OF_MEMORY; }
  free(scratch->allocation);
  scratch->allocation = allocation;
  scratch->capacity = (uint32_t)capacity;
  scratch->bytes = bytes;
  return NARSIL_OK;
}

sort_order_scratch *sort_order_workspace(narsil_workspace *workspace) { return &workspace->sort_order; }

static void order_ordinals(const narsil_sort_values *values, uint32_t *ordinals, uint32_t *spare, size_t count) {
  for (size_t width = 1; width < count;) {
    for (size_t start = 0; start < count;) {
      size_t middle = count - start < width ? count : start + width;
      size_t end = count - middle < width ? count : middle + width;
      size_t left = start;
      size_t right = middle;
      for (size_t at = start; at < end; at++) {
        if (left < middle && (right == end || sort_values_compare(values, ordinals[left], ordinals[right]) <= 0)) {
          spare[at] = ordinals[left++];
        } else {
          spare[at] = ordinals[right++];
        }
      }
      start = end;
    }
    memcpy(ordinals, spare, count * sizeof *ordinals);
    if (width > count / 2) { break; }
    width *= 2;
  }
}

static narsil_status required_room(const narsil_sort_values *current, const uint32_t *ordinals, uint32_t count,
                                   const narsil_sort_values_output *output, uint32_t *distinct) {
  uint32_t unique = 0;
  size_t units = 0;
  for (uint32_t at = 0; at < count; at++) {
    uint32_t ordinal = ordinals[at];
    if (at > 0 && sort_values_compare(current, ordinals[at - 1], ordinal) == 0) { continue; }
    if (unique >= (uint32_t)INT32_MAX / 2) { return NARSIL_INVALID_ARGUMENT; }
    unique++;
    if (current->kinds[ordinal] == NARSIL_SORT_STRING) {
      size_t length = current->text_length[ordinal];
      if (length > UINT32_MAX - units) { return NARSIL_INVALID_ARGUMENT; }
      units += length;
    }
  }
  if (unique > output->capacity || unique > output->number_capacity || unique > output->text_start_capacity ||
      unique > output->text_length_capacity || units > output->unit_capacity) {
    return NARSIL_NEEDS_ROOM;
  }
  *distinct = unique;
  return NARSIL_OK;
}

static void publish(const narsil_sort_values *current, const uint32_t *ordinals, uint32_t count,
                    narsil_sort_order_output *output) {
  for (size_t ordinal = 0; ordinal < current->count; ordinal++) { output->ranks[ordinal] = -1; }
  uint32_t unique = 0;
  uint32_t units = 0;
  for (uint32_t at = 0; at < count; at++) {
    uint32_t ordinal = ordinals[at];
    if (at == 0 || sort_values_compare(current, ordinals[at - 1], ordinal) != 0) {
      uint8_t kind = current->kinds[ordinal];
      output->values.kinds[unique] = kind;
      output->values.numbers[unique] = 0;
      output->values.text_start[unique] = 0;
      output->values.text_length[unique] = 0;
      if (kind == NARSIL_SORT_NUMBER) {
        double value = current->numbers[ordinal];
        output->values.numbers[unique] = value == 0 ? 0 : value;
      } else if (kind == NARSIL_SORT_STRING) {
        uint32_t length = current->text_length[ordinal];
        output->values.text_start[unique] = units;
        output->values.text_length[unique] = length;
        if (length > 0) {
          memcpy(output->values.units + units, current->units + current->text_start[ordinal],
                 (size_t)length * sizeof *current->units);
        }
        units += length;
      }
      unique++;
    }
    output->ranks[ordinal] = (int32_t)(unique * 2U);
    output->ordered[at] = ordinal;
  }
  size_t words = current->count == 0 ? 1 : ((current->count - 1) / BITMAP_WORD_BITS) + 1;
  memset(output->dirty, 0, words * sizeof *output->dirty);
  output->counts[0] = unique;
  output->counts[1] = count;
}

narsil_status narsil_build_sort_order(narsil_workspace *workspace, const narsil_sort_values *current,
                                      const uint32_t *live, size_t live_words, narsil_sort_order_output *output) {
  if (workspace == NULL || current == NULL || output == NULL || !regions_valid(current, live, live_words, output)) {
    return NARSIL_INVALID_ARGUMENT;
  }
  size_t words = current->count == 0 ? 1 : ((current->count - 1) / BITMAP_WORD_BITS) + 1;
  if (live_words < words) { return NARSIL_INVALID_ARGUMENT; }
  uint32_t count = 0;
  for (uint32_t ordinal = 0; ordinal < current->count; ordinal++) {
    if (!live_at(live, ordinal)) { continue; }
    if (!sort_value_at_valid(current, ordinal)) { return NARSIL_INVALID_ARGUMENT; }
    if (current->kinds[ordinal] != NARSIL_SORT_MISSING) { count++; }
  }
  if (output->rank_capacity < current->count || output->ordered_capacity < count || output->dirty_capacity < words ||
      output->count_capacity < 2) {
    return NARSIL_NEEDS_ROOM;
  }
  sort_order_scratch *scratch = &workspace->sort_order;
  narsil_status status = reserve_sort_order(scratch, count);
  if (status != NARSIL_OK) { return status; }
  uint32_t *ordinals = scratch->allocation;
  uint32_t position = 0;
  for (uint32_t ordinal = 0; ordinal < current->count; ordinal++) {
    if (live_at(live, ordinal) && current->kinds[ordinal] != NARSIL_SORT_MISSING) { ordinals[position++] = ordinal; }
  }
  if (count > 1) { order_ordinals(current, ordinals, ordinals + scratch->capacity, count); }
  uint32_t distinct = 0;
  status = required_room(current, ordinals, count, &output->values, &distinct);
  if (status != NARSIL_OK) { return status; }
  publish(current, ordinals, count, output);
  return NARSIL_OK;
}
