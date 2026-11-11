#include "../../include/narsil_core.h"
#include "../../include/narsil_facets.h"
#include "../../include/narsil_stored_values.h"

#include "../regions.h"
#include "../stored_values/values.h"

#include <stddef.h>
#include <stdint.h>

enum { EXTRA_INPUT_REGIONS = 3, WORD_SHIFT = 5, WORD_MASK = 31 };

static int matches_range(const narsil_stored_values *values, size_t ordinal, const double *bounds) {
  uint8_t shape = values->shapes[ordinal];
  uint32_t start = values->starts[ordinal];
  uint32_t end = values->starts[ordinal + 1];
  if (shape == STORED_ABSENT || shape > STORED_ARRAY || start > end || end > values->kind_count ||
      (shape == STORED_SCALAR && end - start != 1)) {
    return 0;
  }
  for (uint32_t at = start; at < end; at++) {
    if (values->kinds[at] != STORED_NUMBER) { continue; }
    double number = values->numbers[at];
    if (number >= bounds[0] && number < bounds[1]) { return 1; }
  }
  return 0;
}

static uint32_t count_range(const narsil_stored_values *values, const uint32_t *matched, size_t matched_words,
                            const double *bounds) {
  if (!(bounds[0] < bounds[1])) { return 0; }
  uint32_t total = 0;
  for (size_t ordinal = 0; ordinal < values->shape_count; ordinal++) {
    size_t word = ordinal >> WORD_SHIFT;
    if (word >= matched_words || (matched[word] & (UINT32_C(1) << (ordinal & WORD_MASK))) == 0) { continue; }
    total += (uint32_t)matches_range(values, ordinal, bounds);
  }
  return total;
}

narsil_status narsil_stored_range_facet(const narsil_stored_values *values, const uint32_t *matched,
                                        size_t matched_words, const double *ranges, size_t range_length,
                                        uint32_t *counts, size_t count_capacity) {
  memory_region inputs[STORED_VALUE_REGIONS + EXTRA_INPUT_REGIONS];
  memory_region output;
  if (values == NULL || matched_words == 0 || range_length % 2 != 0 || range_length / 2 > UINT32_MAX ||
      !stored_value_regions(values, inputs) || !region_of(values, 1, sizeof *values, &inputs[STORED_VALUE_REGIONS]) ||
      !region_of(matched, matched_words, sizeof *matched, &inputs[STORED_VALUE_REGIONS + 1]) ||
      !region_of(ranges, range_length, sizeof *ranges, &inputs[STORED_VALUE_REGIONS + 2]) ||
      !region_of(counts, count_capacity, sizeof *counts, &output)) {
    return NARSIL_INVALID_ARGUMENT;
  }
  for (size_t at = 0; at < STORED_VALUE_REGIONS + EXTRA_INPUT_REGIONS; at++) {
    if (overlaps(output, inputs[at])) { return NARSIL_INVALID_ARGUMENT; }
  }
  size_t range_count = range_length / 2;
  if (count_capacity < range_count) { return NARSIL_NEEDS_ROOM; }
  for (size_t range = 0; range < range_count; range++) {
    counts[range] = count_range(values, matched, matched_words, ranges + (range * 2));
  }
  return NARSIL_OK;
}
