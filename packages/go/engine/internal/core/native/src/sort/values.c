#include "values.h"

#include "../../include/narsil_sort.h"
#include "../../include/narsil_sort_order.h"
#include "../regions.h"
#include "text.h"

#include <math.h>
#include <stddef.h>
#include <stdint.h>

int sort_value_regions(const narsil_sort_values *values, memory_region *regions) {
  if (values->count > UINT32_MAX || values->number_count != values->count ||
      values->text_start_count != values->count || values->text_length_count != values->count ||
      values->unit_count > UINT32_MAX) {
    return 0;
  }
  return region_of(values->kinds, values->count, sizeof *values->kinds, &regions[0]) &&
         region_of(values->numbers, values->number_count, sizeof *values->numbers, &regions[1]) &&
         region_of(values->text_start, values->text_start_count, sizeof *values->text_start, &regions[2]) &&
         region_of(values->text_length, values->text_length_count, sizeof *values->text_length, &regions[3]) &&
         region_of(values->units, values->unit_count, sizeof *values->units, &regions[4]);
}

int sort_value_at_valid(const narsil_sort_values *values, uint32_t ordinal) {
  uint8_t kind = values->kinds[ordinal];
  if (kind > NARSIL_SORT_TRUE) { return 0; }
  if (kind == NARSIL_SORT_NUMBER) { return isfinite(values->numbers[ordinal]); }
  if (kind != NARSIL_SORT_STRING) { return 1; }
  size_t start = values->text_start[ordinal];
  size_t length = values->text_length[ordinal];
  if (start > values->unit_count || length > values->unit_count - start) { return 0; }
  const uint16_t *units = values->units == NULL ? NULL : values->units + start;
  return sort_text_length(units, length) == length;
}

int sort_values_compare(const narsil_sort_values *values, uint32_t left, uint32_t right) {
  return sort_values_compare_between(values, left, values, right);
}

int sort_values_compare_between(const narsil_sort_values *lhs_values, uint32_t left,
                                const narsil_sort_values *rhs_values, uint32_t right) {
  uint8_t first = lhs_values->kinds[left];
  uint8_t second = rhs_values->kinds[right];
  if (first != second) { return first < second ? -1 : 1; }
  if (first == NARSIL_SORT_NUMBER) {
    double lhs = lhs_values->numbers[left];
    double rhs = rhs_values->numbers[right];
    if (lhs == rhs) { return 0; }
    return lhs < rhs ? -1 : 1;
  }
  if (first != NARSIL_SORT_STRING) { return 0; }
  const uint16_t *lhs = lhs_values->units == NULL ? NULL : lhs_values->units + lhs_values->text_start[left];
  const uint16_t *rhs = rhs_values->units == NULL ? NULL : rhs_values->units + rhs_values->text_start[right];
  return sort_text_compare(lhs, lhs_values->text_length[left], rhs, rhs_values->text_length[right]);
}
