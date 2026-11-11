#include "../../include/narsil_core.h"
#include "../../include/narsil_sort.h"
#include "../../include/narsil_stored_values.h"

#include "../allocation.h"
#include "../internal.h"
#include "../regions.h"
#include "../stored_values/values.h"
#include "scratch.h"
#include "text.h"

#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

enum { NUMBER_REGION, TEXT_REGION, OUTPUT_METADATA, OUTPUT_REGIONS };
enum { MAX_TEXT_UNITS = 0x40000000U };

static int request_valid(const narsil_stored_values *values, uint32_t ordinal, uint32_t mode,
                         const narsil_sort_value_output *output) {
  if (values == NULL || output == NULL || mode > NARSIL_SORT_MEDIAN || ordinal >= values->shape_count) { return 0; }
  memory_region inputs[STORED_VALUE_REGIONS + 1];
  memory_region outputs[OUTPUT_REGIONS];
  if (!stored_value_regions(values, inputs) || !region_of(values, 1, sizeof *values, &inputs[STORED_VALUE_REGIONS]) ||
      !region_of(output->number, output->number_capacity, sizeof *output->number, &outputs[NUMBER_REGION]) ||
      !region_of(output->text, output->text_capacity, sizeof *output->text, &outputs[TEXT_REGION]) ||
      !region_of(output, 1, sizeof *output, &outputs[OUTPUT_METADATA])) {
    return 0;
  }
  for (size_t target = 0; target < OUTPUT_REGIONS; target++) {
    for (size_t source = 0; source <= STORED_VALUE_REGIONS; source++) {
      if (overlaps(outputs[target], inputs[source])) { return 0; }
    }
    for (size_t prior = 0; prior < target; prior++) {
      if (overlaps(outputs[target], outputs[prior])) { return 0; }
    }
  }
  if (!stored_value_valid(values, ordinal)) { return 0; }
  uint32_t end = values->starts[(size_t)ordinal + 1];
  for (uint32_t index = values->starts[ordinal]; index < end; index++) {
    if (values->kinds[index] == STORED_STRING && values->text_length[index] > MAX_TEXT_UNITS) { return 0; }
  }
  return 1;
}

static uint32_t sort_kind(const narsil_stored_values *values, uint32_t index) {
  switch (values->kinds[index]) {
    case STORED_NUMBER:
      return isfinite(values->numbers[index]) ? NARSIL_SORT_NUMBER : NARSIL_SORT_MISSING;
    case STORED_STRING:
      return NARSIL_SORT_STRING;
    case STORED_FALSE:
      return NARSIL_SORT_FALSE;
    case STORED_TRUE:
      return NARSIL_SORT_TRUE;
    default:
      return NARSIL_SORT_MISSING;
  }
}

static const uint16_t *text_of(const narsil_stored_values *values, uint32_t index) {
  return values->units == NULL ? NULL : values->units + values->text_start[index];
}

static size_t text_length(const narsil_stored_values *values, uint32_t index) {
  return sort_text_length(text_of(values, index), values->text_length[index]);
}

static int compare_elements(const narsil_stored_values *values, uint32_t left, uint32_t right) {
  uint32_t kind = sort_kind(values, left);
  uint32_t other_kind = sort_kind(values, right);
  if (kind != other_kind) { return kind < other_kind ? -1 : 1; }
  if (kind == NARSIL_SORT_NUMBER) {
    double first = values->numbers[left];
    double second = values->numbers[right];
    if (first == second) { return 0; }
    return first < second ? -1 : 1;
  }
  if (kind == NARSIL_SORT_STRING) {
    return sort_text_compare(text_of(values, left), text_length(values, left), text_of(values, right),
                             text_length(values, right));
  }
  return 0;
}

static uint32_t choose_element(const narsil_stored_values *values, uint32_t first, uint32_t end, uint32_t mode) {
  uint32_t chosen = end;
  for (uint32_t index = first; index < end; index++) {
    if (sort_kind(values, index) == NARSIL_SORT_MISSING) { continue; }
    if (chosen == end) {
      chosen = index;
    } else {
      int order = compare_elements(values, index, chosen);
      if (mode == NARSIL_SORT_MAX ? order > 0 : order < 0) { chosen = index; }
    }
  }
  return chosen;
}

static narsil_status reserve(sort_scratch *scratch, uint32_t needed) {
  if (needed <= scratch->capacity) { return NARSIL_OK; }
  size_t capacity = grown_capacity(scratch->capacity == 0 ? 1 : scratch->capacity, needed);
  if (capacity > SIZE_MAX / (2 * sizeof(double))) { return NARSIL_INVALID_ARGUMENT; }
  size_t bytes = capacity * 2 * sizeof(double);
  double *allocation = core_allocate(bytes);
  if (allocation == NULL) { return NARSIL_OUT_OF_MEMORY; }
  free(scratch->allocation);
  scratch->allocation = allocation;
  scratch->capacity = (uint32_t)capacity;
  scratch->bytes = bytes;
  return NARSIL_OK;
}

static void stable_sort(double *numbers, double *spare, size_t count) {
  for (size_t width = 1; width < count;) {
    for (size_t start = 0; start < count;) {
      size_t middle = count - start < width ? count : start + width;
      size_t end = count - middle < width ? count : middle + width;
      size_t left = start;
      size_t right = middle;
      for (size_t index = start; index < end; index++) {
        if (left < middle && (right == end || numbers[left] <= numbers[right])) {
          spare[index] = numbers[left++];
        } else {
          spare[index] = numbers[right++];
        }
      }
      start = end;
    }
    memcpy(numbers, spare, count * sizeof *numbers);
    if (width > count / 2) { break; }
    width *= 2;
  }
}

static narsil_status reduce_numbers(sort_scratch *scratch, const narsil_stored_values *values, uint32_t first,
                                    uint32_t end, uint32_t mode, narsil_sort_value_output *output) {
  if (mode == NARSIL_SORT_MEDIAN) {
    narsil_status status = reserve(scratch, end - first);
    if (status != NARSIL_OK) { return status; }
  }
  double mean = 0;
  uint32_t seen = 0;
  for (uint32_t index = first; index < end; index++) {
    if (sort_kind(values, index) != NARSIL_SORT_NUMBER) { continue; }
    double value = values->numbers[index];
    if (mode == NARSIL_SORT_MEDIAN) {
      scratch->allocation[seen++] = value;
    } else {
      seen++;
      double difference = value - mean;
      if (isfinite(difference)) {
        mean += difference / seen;
      } else {
        double weight = (double)(seen - 1) / seen;
        mean = (mean * weight) + (value / seen);
      }
    }
  }
  if (seen == 0) {
    output->kind = NARSIL_SORT_MISSING;
    return NARSIL_OK;
  }
  if (mode == NARSIL_SORT_MEDIAN) {
    double *numbers = scratch->allocation;
    stable_sort(numbers, numbers + scratch->capacity, seen);
    uint32_t middle = seen / 2;
    mean = seen % 2 == 1 ? numbers[middle] : (numbers[middle - 1] / 2) + (numbers[middle] / 2);
  }
  output->number[0] = mean;
  output->kind = NARSIL_SORT_NUMBER;
  return NARSIL_OK;
}

narsil_status narsil_sort_value(narsil_workspace *workspace, const narsil_stored_values *values, uint32_t ordinal,
                                uint32_t mode, narsil_sort_value_output *output) {
  if (workspace == NULL || !request_valid(values, ordinal, mode, output)) { return NARSIL_INVALID_ARGUMENT; }
  if (output->number_capacity < 1 || output->text_capacity < 2) { return NARSIL_NEEDS_ROOM; }
  uint32_t first = values->starts[ordinal];
  uint32_t end = values->starts[(size_t)ordinal + 1];
  if (values->shapes[ordinal] == STORED_ARRAY && mode >= NARSIL_SORT_AVG) {
    return reduce_numbers(&workspace->sort, values, first, end, mode, output);
  }
  uint32_t chosen = choose_element(values, first, end, mode);
  uint32_t kind = chosen == end ? NARSIL_SORT_MISSING : sort_kind(values, chosen);
  if (kind == NARSIL_SORT_NUMBER) {
    output->number[0] = values->numbers[chosen];
  } else if (kind == NARSIL_SORT_STRING) {
    output->text[0] = values->text_start[chosen];
    output->text[1] = (uint32_t)text_length(values, chosen);
  }
  output->kind = kind;
  return NARSIL_OK;
}
