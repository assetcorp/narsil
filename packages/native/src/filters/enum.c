#include "../../include/narsil_filters.h"
#include "constants.h"
#include "internal.h"

#include <stddef.h>
#include <stdint.h>

typedef struct {
  const uint16_t *units;
  size_t unit_count;
  const uint32_t *offsets;
  const uint32_t *suffix_order;
  size_t count;
  const uint16_t *text;
  size_t text_length;
  int suffix;
  int prefix;
} enum_test;

static int compare(const enum_test *test, size_t position) {
  size_t index = test->suffix ? test->suffix_order[position] : position;
  if (index >= test->count) { return -1; }
  size_t start = test->offsets[index];
  size_t end = test->offsets[index + 1];
  if (start > end || end > test->unit_count || end - start > FILTER_MAX_TEXT) { return -1; }
  size_t length = end - start;
  size_t common = length < test->text_length ? length : test->text_length;
  for (size_t at = 0; at < common; at++) {
    int difference = (int)test->units[test->suffix ? end - at - 1 : start + at] -
                     (int)test->text[test->suffix ? test->text_length - at - 1 : at];
    if (difference != 0) { return difference; }
  }
  if (test->prefix && length >= test->text_length) { return 0; }
  return (length > test->text_length) - (length < test->text_length);
}

void filter_enum_test(const narsil_filter_program *program, const narsil_filter_field *field, uint32_t operator,
                      uint32_t operand, uint32_t *into) {
  size_t text_start = program->offsets[operand];
  enum_test test = {field->regions[1].data,
                    field->regions[1].length,
                    field->regions[2].data,
                    field->regions[NARSIL_FILTER_FIELD_REGIONS - 1].data,
                    field->regions[NARSIL_FILTER_FIELD_REGIONS - 1].length,
                    program->units == NULL ? NULL : program->units + text_start,
                    program->offsets[(size_t)operand + 1] - text_start,
                    operator == NARSIL_FILTER_SUFFIX,
                    operator == NARSIL_FILTER_PREFIX || operator == NARSIL_FILTER_SUFFIX};
  size_t low = 0;
  size_t high = test.count;
  while (low < high) {
    size_t middle = low + ((high - low) / 2);
    if (compare(&test, middle) < 0) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  const uint32_t *offsets = field->regions[3].data;
  const uint32_t *postings = field->regions[4].data;
  for (size_t at = low; at < test.count && compare(&test, at) == 0; at++) {
    size_t index = test.suffix ? test.suffix_order[at] : at;
    size_t start = offsets[index];
    size_t end = offsets[index + 1];
    if (start > end || end > field->regions[4].length) { continue; }
    for (size_t entry = start; entry < end; entry++) { filter_set(into, program->live.count, postings[entry]); }
  }
}
