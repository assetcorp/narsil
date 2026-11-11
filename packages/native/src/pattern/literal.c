#include "literal.h"

#include "../../include/narsil_core.h"
#include "../allocation.h"
#include "../work/tally.h"
#include "text.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

narsil_status pattern_literal_prepare(pattern_literal *literal, const uint32_t *points, uint32_t length) {
  size_t slots = (size_t)length + 1;
  if (slots <= length || slots > SIZE_MAX / (2 * sizeof(uint32_t))) { return NARSIL_OUT_OF_MEMORY; }
  if (slots > literal->capacity) {
    uint32_t *allocation = core_reallocate(literal->allocation, slots * 2 * sizeof *allocation);
    if (allocation == NULL) { return NARSIL_OUT_OF_MEMORY; }
    literal->allocation = allocation;
    literal->capacity = slots;
  }
  literal->points = points;
  literal->length = length;
  literal->borders = literal->allocation;
  literal->reachable = literal->allocation + literal->capacity;
  memset(literal->borders, 0, slots * sizeof *literal->borders);
  memset(literal->reachable, 0, slots * sizeof *literal->reachable);
  uint32_t border = 0;
  for (uint32_t at = 1; at < length; at++) {
    while (border > 0 && points[at] != points[border]) { border = literal->borders[border]; }
    if (points[at] == points[border]) { border++; }
    literal->borders[at + 1] = border;
  }
  for (size_t prefix = 1; prefix <= length; prefix++) {
    literal->reachable[prefix] = (uint32_t)(prefix < length) + literal->reachable[literal->borders[prefix]];
  }
  return NARSIL_OK;
}

static int anchored_match(const pattern_literal *literal, pattern_text_cursor *value, work_tally *tally) {
  uint32_t point = 0;
  for (uint32_t prefix = 0; prefix < literal->length; prefix++) {
    if (!pattern_text_next(value, &point)) { return 0; }
    if (work_tally_add(tally, 1) != NARSIL_OK || literal->points[prefix] != point) { return 0; }
  }
  return literal->anchored_end == 0 || !pattern_text_next(value, &point);
}

int pattern_literal_match(const pattern_literal *literal, pattern_text_cursor *value, work_tally *tally) {
  uint32_t point = 0;
  if (literal->length == 0) {
    return literal->anchored_end == 0 || literal->anchored_start == 0 || !pattern_text_next(value, &point);
  }
  if (literal->anchored_start != 0) { return anchored_match(literal, value, tally); }
  uint32_t prefix = 0;
  while (pattern_text_next(value, &point)) {
    if (work_tally_add(tally, (uint64_t)literal->reachable[prefix] + 1) != NARSIL_OK) { return 0; }
    if (prefix == literal->length) { prefix = literal->borders[prefix]; }
    while (prefix > 0 && literal->points[prefix] != point) { prefix = literal->borders[prefix]; }
    if (literal->points[prefix] == point) { prefix++; }
    if (literal->anchored_end == 0 && prefix == literal->length) { return 1; }
  }
  return prefix == literal->length;
}
