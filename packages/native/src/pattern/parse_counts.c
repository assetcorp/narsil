#include "parse.h"

#include "../../include/narsil_core.h"
#include "ast.h"
#include "constants.h"
#include "number_range.h"

#include <stdint.h>

enum { DECIMAL_BASE = 10 };

static int is_digit(uint32_t point) { return point >= '0' && point <= '9'; }

static uint32_t read_count(pattern_reader *reader) {
  if (!is_digit(pattern_peek(reader))) { return pattern_parse_fail(reader); }
  uint32_t count = 0;
  while (is_digit(pattern_peek(reader))) {
    count = (count * DECIMAL_BASE) + pattern_peek(reader) - '0';
    if (count > PATTERN_MAX_REPEAT_COUNT) { return pattern_parse_fail(reader); }
    reader->position++;
  }
  return count;
}

static uint32_t repeated_count(pattern_reader *reader, uint32_t body) {
  pattern_bounds bounds = {read_count(reader), 0};
  bounds.maximum = bounds.minimum;
  if (pattern_peek(reader) == ',') {
    reader->position++;
    bounds.maximum = is_digit(pattern_peek(reader)) ? read_count(reader) : PATTERN_UNBOUNDED;
  }
  if (reader->tree->status != NARSIL_OK || pattern_peek(reader) != '}' || bounds.minimum > bounds.maximum) {
    return pattern_parse_fail(reader);
  }
  reader->position++;
  return pattern_node_repeat(reader->tree, body, bounds);
}

static int is_repeat(uint32_t point) { return point == '*' || point == '+' || point == '?' || point == '{'; }

uint32_t pattern_parse_repeat(pattern_reader *reader, uint32_t body) {
  uint32_t point = pattern_peek(reader);
  if (!is_repeat(point)) { return body; }
  reader->position++;
  uint32_t repeated = PATTERN_NO_NODE;
  if (point == '{') {
    repeated = repeated_count(reader, body);
  } else {
    pattern_bounds bounds = {(uint32_t)(point == '+'), point == '?' ? 1 : PATTERN_UNBOUNDED};
    repeated = pattern_node_repeat(reader->tree, body, bounds);
  }
  return is_repeat(pattern_peek(reader)) ? pattern_parse_fail(reader) : repeated;
}

static pattern_digits read_digits(pattern_reader *reader) {
  pattern_digits digits = {{0}, 0};
  while (is_digit(pattern_peek(reader))) {
    if (digits.count == PATTERN_MAX_NUMBER_RANGE_DIGITS) {
      (void)pattern_parse_fail(reader);
      break;
    }
    digits.digits[digits.count++] = (uint8_t)(pattern_peek(reader) - '0');
    reader->position++;
  }
  return digits;
}

uint32_t pattern_parse_number_range(pattern_reader *reader) {
  pattern_digits low = read_digits(reader);
  if (reader->tree->status != NARSIL_OK || pattern_peek(reader) != '-') { return pattern_parse_fail(reader); }
  reader->position++;
  pattern_digits high = read_digits(reader);
  if (reader->tree->status != NARSIL_OK || pattern_peek(reader) != '>') { return pattern_parse_fail(reader); }
  reader->position++;
  return pattern_number_range(reader->tree, &low, &high);
}
