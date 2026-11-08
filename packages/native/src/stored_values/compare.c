#include "values.h"

#include "../../include/narsil_stored_values.h"

#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

static int compare_text(const narsil_stored_values *values, uint32_t lhs, uint32_t rhs) {
  uint32_t left = lhs;
  uint32_t right = rhs;
  uint32_t left_length = values->text_length[left];
  uint32_t right_length = values->text_length[right];
  uint32_t length = left_length < right_length ? left_length : right_length;
  uint32_t left_start = values->text_start[left];
  uint32_t right_start = values->text_start[right];
  if (values->kinds[left] == STORED_OTHER) {
    if (length > 0) {
      int order = memcmp(values->bytes + left_start, values->bytes + right_start, length);
      if (order != 0) { return order; }
    }
  } else {
    for (uint32_t at = 0; at < length; at++) {
      uint16_t first = values->units[(size_t)left_start + at];
      uint16_t second = values->units[(size_t)right_start + at];
      if (first != second) { return first < second ? -1 : 1; }
    }
  }
  if (left_length == right_length) { return 0; }
  return left_length < right_length ? -1 : 1;
}

static int compare_numbers(double first, double second) {
  if (first == second) { return 0; }
  if (isnan(first)) { return isnan(second) ? 0 : 1; }
  return isnan(second) || first < second ? -1 : 1;
}

int stored_element_compare(const narsil_stored_values *values, uint32_t left, uint32_t right) {
  uint8_t kind = values->kinds[left];
  if (kind != values->kinds[right]) { return kind < values->kinds[right] ? -1 : 1; }
  if (kind == STORED_STRING || kind == STORED_OTHER) { return compare_text(values, left, right); }
  if (kind != STORED_NUMBER) { return 0; }
  return compare_numbers(values->numbers[left], values->numbers[right]);
}

static uint8_t effective_shape(const narsil_stored_values *values, uint32_t ordinal) {
  uint8_t shape = values->shapes[ordinal];
  if (shape == STORED_SCALAR && values->kinds[values->starts[ordinal]] == STORED_NULL) { return STORED_ABSENT; }
  return shape;
}

int stored_value_compare(const narsil_stored_values *values, uint32_t left, uint32_t right) {
  uint8_t shape = effective_shape(values, left);
  uint8_t other_shape = effective_shape(values, right);
  if (shape != other_shape) { return shape < other_shape ? -1 : 1; }
  if (shape == STORED_ABSENT) { return 0; }
  uint32_t first = values->starts[left];
  uint32_t second = values->starts[right];
  uint32_t first_length = values->starts[(size_t)left + 1] - first;
  uint32_t second_length = values->starts[(size_t)right + 1] - second;
  uint32_t length = first_length < second_length ? first_length : second_length;
  for (uint32_t at = 0; at < length; at++) {
    int order = stored_element_compare(values, first + at, second + at);
    if (order != 0) { return order; }
  }
  if (first_length == second_length) { return 0; }
  return first_length < second_length ? -1 : 1;
}
