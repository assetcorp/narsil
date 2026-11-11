#include "../../include/narsil_sort_order.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_sort.h"
#include "../regions.h"
#include "text.h"
#include "values.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

enum { WORD_BITS = 32, WORD_SHIFT = 5, WORD_MASK = 31, MAX_TEXT_UNITS = 1U << 30 };
enum {
  RANK_REGION = SORT_VALUE_REGIONS * 2,
  ORDER_REGION,
  DIRTY_REGION,
  LIVE_REGION,
  LOWER_REGION,
  UPPER_REGION,
  COLUMN_REGION,
  REQUEST_REGION,
  REGION_COUNT
};

static int marked(const uint32_t *bits, size_t ordinal) {
  return (bits[ordinal >> WORD_SHIFT] & (UINT32_C(1) << (ordinal & WORD_MASK))) != 0;
}

static int valid_bound(narsil_sort_bound bound) {
  return bound.present <= 1 && bound.inclusive <= 1 && bound.length <= MAX_TEXT_UNITS &&
         (bound.present != 0 || bound.length == 0);
}

static int valid_regions(const narsil_sort_column *column, const narsil_text_range_request *request) {
  memory_region inputs[REGION_COUNT];
  memory_region output;
  if (!sort_value_regions(&column->current, inputs) ||
      !sort_value_regions(&column->values, inputs + SORT_VALUE_REGIONS) ||
      !region_of(column->ranks, column->rank_count, sizeof *column->ranks, &inputs[RANK_REGION]) ||
      !region_of(column->ordered, column->ordered_count, sizeof *column->ordered, &inputs[ORDER_REGION]) ||
      !region_of(column->dirty, column->dirty_words, sizeof *column->dirty, &inputs[DIRTY_REGION]) ||
      !region_of(request->live, request->live_words, sizeof *request->live, &inputs[LIVE_REGION]) ||
      !region_of(request->lower.units, request->lower.length, sizeof *request->lower.units, &inputs[LOWER_REGION]) ||
      !region_of(request->upper.units, request->upper.length, sizeof *request->upper.units, &inputs[UPPER_REGION]) ||
      !region_of(column, 1, sizeof *column, &inputs[COLUMN_REGION]) ||
      !region_of(request, 1, sizeof *request, &inputs[REQUEST_REGION]) ||
      !region_of(request->output, request->output_words, sizeof *request->output, &output)) {
    return 0;
  }
  for (size_t index = 0; index < REGION_COUNT; index++) {
    if (overlaps(output, inputs[index])) { return 0; }
  }
  return 1;
}

static int compare_bound(const narsil_sort_values *values, uint32_t ordinal, narsil_sort_bound bound) {
  uint8_t kind = values->kinds[ordinal];
  if (kind != NARSIL_SORT_STRING) { return kind < NARSIL_SORT_STRING ? -1 : 1; }
  const uint16_t *units = values->units == NULL ? NULL : values->units + values->text_start[ordinal];
  return sort_text_compare(units, values->text_length[ordinal], bound.units, bound.length);
}

static uint32_t bound_position(const narsil_sort_values *values, narsil_sort_bound bound, int after_equal) {
  size_t low = 0;
  size_t high = values->count;
  while (low < high) {
    size_t middle = low + ((high - low) / 2);
    int comparison = compare_bound(values, (uint32_t)middle, bound);
    if (comparison < 0 || (comparison == 0 && after_equal)) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return (uint32_t)low;
}

static size_t seek(const narsil_sort_column *column, uint32_t value_index) {
  size_t low = 0;
  size_t high = column->ordered_count;
  uint32_t rank = (value_index * 2U) + 2U;
  while (low < high) {
    size_t middle = low + ((high - low) / 2);
    uint32_t ordinal = column->ordered[middle];
    if (ordinal < column->rank_count && column->ranks[ordinal] >= 0 && (uint32_t)column->ranks[ordinal] < rank) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

static int within_bounds(const narsil_sort_values *values, uint32_t ordinal, const narsil_text_range_request *request) {
  if (!sort_value_at_valid(values, ordinal) || values->kinds[ordinal] == NARSIL_SORT_MISSING) { return 0; }
  if (request->lower.present) {
    int comparison = compare_bound(values, ordinal, request->lower);
    if (comparison < 0 || (comparison == 0 && !request->lower.inclusive)) { return 0; }
  }
  if (request->upper.present) {
    int comparison = compare_bound(values, ordinal, request->upper);
    if (comparison > 0 || (comparison == 0 && !request->upper.inclusive)) { return 0; }
  }
  return 1;
}

narsil_status narsil_text_range(const narsil_sort_column *column, const narsil_text_range_request *request) {
  if (column == NULL || request == NULL || !valid_bound(request->lower) || !valid_bound(request->upper) ||
      !valid_regions(column, request) || column->values.count > (uint32_t)INT32_MAX / 2 ||
      column->rank_count > column->current.count || column->ordered_count > UINT32_MAX) {
    return NARSIL_INVALID_ARGUMENT;
  }
  size_t count = column->current.count;
  size_t words = count == 0 ? 1 : ((count - 1) / WORD_BITS) + 1;
  if (request->live_words < words || column->dirty_words < words) { return NARSIL_INVALID_ARGUMENT; }
  for (uint32_t index = 0; index < column->values.count; index++) {
    if (!sort_value_at_valid(&column->values, index) || column->values.kinds[index] == NARSIL_SORT_MISSING) {
      return NARSIL_INVALID_ARGUMENT;
    }
  }
  if (request->output_words < words) { return NARSIL_NEEDS_ROOM; }
  narsil_text_range_request bounded = *request;
  bounded.lower.length = sort_text_length(request->lower.units, request->lower.length);
  bounded.upper.length = sort_text_length(request->upper.units, request->upper.length);
  size_t start = bounded.lower.present
                     ? seek(column, bound_position(&column->values, bounded.lower, !bounded.lower.inclusive))
                     : 0;
  size_t end = bounded.upper.present
                   ? seek(column, bound_position(&column->values, bounded.upper, bounded.upper.inclusive != 0))
                   : column->ordered_count;
  memset(request->output, 0, words * sizeof *request->output);
  for (size_t at = start; at < end; at++) {
    uint32_t ordinal = column->ordered[at];
    if (ordinal >= count || ordinal >= column->rank_count || column->ranks[ordinal] < 2 ||
        (column->ranks[ordinal] & 1) != 0 || (uint32_t)column->ranks[ordinal] / 2 > column->values.count ||
        marked(column->dirty, ordinal) || !marked(request->live, ordinal)) {
      continue;
    }
    request->output[ordinal >> WORD_SHIFT] |= UINT32_C(1) << (ordinal & WORD_MASK);
  }
  for (size_t word = 0; word < words; word++) {
    uint32_t dirty = column->dirty[word] & request->live[word];
    for (uint32_t bit = 0; dirty != 0 && bit < WORD_BITS; bit++, dirty >>= 1U) {
      size_t ordinal = (word * WORD_BITS) + bit;
      if ((dirty & 1U) != 0 && ordinal < count && within_bounds(&column->current, (uint32_t)ordinal, &bounded)) {
        request->output[word] |= UINT32_C(1) << bit;
      }
    }
  }
  return NARSIL_OK;
}
