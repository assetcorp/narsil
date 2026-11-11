#include "values.h"

#include "../../include/narsil_stored_values.h"
#include "../regions.h"

#include <stddef.h>
#include <stdint.h>

int stored_value_regions(const narsil_stored_values *values, memory_region regions[STORED_VALUE_REGIONS]) {
  if (values->shape_count > UINT32_MAX || values->shape_count == SIZE_MAX ||
      values->start_count != values->shape_count + 1 || values->kind_count > UINT32_MAX ||
      values->number_count != values->kind_count || values->text_start_count != values->kind_count ||
      values->text_length_count != values->kind_count || values->unit_count > UINT32_MAX ||
      values->byte_count > UINT32_MAX) {
    return 0;
  }
  enum { TEXT_LENGTH_REGION = 5, UNITS_REGION, BYTES_REGION };
  return region_of(values->shapes, values->shape_count, sizeof *values->shapes, &regions[0]) &&
         region_of(values->starts, values->start_count, sizeof *values->starts, &regions[1]) &&
         region_of(values->kinds, values->kind_count, sizeof *values->kinds, &regions[2]) &&
         region_of(values->numbers, values->number_count, sizeof *values->numbers, &regions[3]) &&
         region_of(values->text_start, values->text_start_count, sizeof *values->text_start, &regions[4]) &&
         region_of(values->text_length, values->text_length_count, sizeof *values->text_length,
                   &regions[TEXT_LENGTH_REGION]) &&
         region_of(values->units, values->unit_count, sizeof *values->units, &regions[UNITS_REGION]) &&
         region_of(values->bytes, values->byte_count, sizeof *values->bytes, &regions[BYTES_REGION]);
}

int stored_element_valid(const narsil_stored_values *values, uint32_t index) {
  if (index >= values->kind_count) { return 0; }
  uint8_t kind = values->kinds[index];
  if (kind > STORED_OTHER) { return 0; }
  if (kind != STORED_STRING && kind != STORED_OTHER) { return 1; }
  size_t capacity = kind == STORED_STRING ? values->unit_count : values->byte_count;
  uint32_t start = values->text_start[index];
  uint32_t length = values->text_length[index];
  return start <= capacity && length <= capacity - start;
}

int stored_value_valid(const narsil_stored_values *values, uint32_t ordinal) {
  if (ordinal >= values->shape_count) { return 0; }
  uint8_t shape = values->shapes[ordinal];
  uint32_t start = values->starts[ordinal];
  uint32_t end = values->starts[(size_t)ordinal + 1];
  if (shape > STORED_ARRAY || start > end || end > values->kind_count || (shape == STORED_ABSENT && start != end) ||
      (shape == STORED_SCALAR && end - start != 1)) {
    return 0;
  }
  for (uint32_t at = start; at < end; at++) {
    if (!stored_element_valid(values, at)) { return 0; }
  }
  return 1;
}
