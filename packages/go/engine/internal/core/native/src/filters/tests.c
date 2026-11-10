#include "../../include/narsil_filters.h"
#include "geo.h"
#include "internal.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

static size_t number_bound(double value, const narsil_filter_region *region, int upper) {
  const double *values = region->data;
  size_t count = region->length;
  size_t low = 0;
  size_t high = count;
  while (low < high) {
    size_t middle = low + ((high - low) / 2);
    if (upper ? values[middle] <= value : values[middle] < value) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

static void numeric_test(const narsil_filter_program *program, const narsil_filter_field *field, uint32_t operator,
                         uint32_t operand, uint32_t *into) {
  const uint32_t *ordinals = field->regions[2].data;
  size_t count = field->regions[1].length;
  double value = program->numbers[operand];
  size_t start = operator == NARSIL_FILTER_LT || operator == NARSIL_FILTER_LTE
                     ? 0
                     : number_bound(value, &field->regions[1], operator == NARSIL_FILTER_GT);
  size_t end = operator == NARSIL_FILTER_GT || operator == NARSIL_FILTER_GTE
                   ? count
                   : number_bound(operator == NARSIL_FILTER_BETWEEN ? program->numbers[(size_t)operand + 1] : value,
                                  &field->regions[1], operator != NARSIL_FILTER_LT);
  for (size_t at = start; at < end; at++) { filter_set(into, program->live.count, ordinals[at]); }
}

static void equal_test(const narsil_filter_program *program, const narsil_filter_field *field, uint32_t operator,
                       uint32_t operand, uint32_t *into, filter_geo_scratch *geo) {
  if (field->kind == NARSIL_FILTER_NUMERIC) {
    numeric_test(program, field, operator, operand, into);
  } else if (field->kind == NARSIL_FILTER_BOOLEAN) {
    const narsil_filter_region *region = &field->regions[program->numbers[operand] == 1 ? 1 : 2];
    const uint32_t *bits = region->data;
    size_t words = region->length < program->live.count ? region->length : program->live.count;
    for (size_t word = 0; word < words; word++) { into[word] |= bits[word]; }
  } else if (field->kind == NARSIL_FILTER_ENUM) {
    filter_enum_test(program, field, operator, operand, into);
  } else if (field->kind == NARSIL_FILTER_GEO) {
    filter_geo_test(program, field, operand, into, geo, operator);
  }
}

void filter_test(const narsil_filter_program *program, const narsil_filter_field *field, uint32_t operator,
                 uint32_t operand, uint32_t *into, uint32_t *scratch, filter_geo_scratch *geo) {
  size_t words = program->live.count;
  memset(into, 0, words * sizeof *into);
  if (operator != NARSIL_FILTER_ANY && operator != NARSIL_FILTER_ALL) {
    equal_test(program, field, operator, operand, into, geo);
    return;
  }
  size_t count =
      field->kind == NARSIL_FILTER_ENUM ? program->lists[((size_t)operand * 2) + 1] : (size_t)program->numbers[operand];
  size_t start = field->kind == NARSIL_FILTER_ENUM ? program->lists[(size_t)operand * 2] : (size_t)operand + 1;
  if (operator == NARSIL_FILTER_ALL) { memcpy(into, program->live.words, words * sizeof *into); }
  for (size_t at = 0; at < count; at++) {
    if (operator == NARSIL_FILTER_ANY) {
      equal_test(program, field, NARSIL_FILTER_EQ, (uint32_t)(start + at), into, geo);
    } else {
      memset(scratch, 0, words * sizeof *scratch);
      equal_test(program, field, NARSIL_FILTER_EQ, (uint32_t)(start + at), scratch, geo);
      for (size_t word = 0; word < words; word++) { into[word] &= scratch[word]; }
    }
  }
}
