#include "typo.h"

#include "../../include/narsil_core.h"
#include "../allocation.h"
#include "../analysis/text.h"
#include "../work/tally.h"
#include "text.h"

#include <stddef.h>
#include <stdint.h>

narsil_status pattern_typo_reserve(pattern_typo *typo) {
  size_t length = typo->case_fold != 0 ? typo->folded.length : typo->raw.length;
  if (length > SIZE_MAX - typo->tolerance - 1) { return NARSIL_OUT_OF_MEMORY; }
  size_t slots = length + typo->tolerance + 1;
  if (slots > SIZE_MAX / (2 * sizeof(uint32_t))) { return NARSIL_OUT_OF_MEMORY; }
  int status = narsil_code_points_reserve(&typo->value, slots);
  if (status != NARSIL_OK) { return (narsil_status)status; }
  if (slots > typo->row_capacity) {
    uint32_t *rows = core_reallocate(typo->rows, slots * 2 * sizeof *rows);
    if (rows == NULL) { return NARSIL_OUT_OF_MEMORY; }
    typo->rows = rows;
    typo->row_capacity = slots;
  }
  return NARSIL_OK;
}

static uint32_t minimum(uint32_t left, uint32_t right) { return left < right ? left : right; }

static int distance_within(pattern_typo *typo, const narsil_code_points *query, work_tally *tally) {
  uint32_t tolerance = typo->tolerance;
  uint32_t beyond = tolerance + 1;
  uint32_t *previous = typo->rows;
  uint32_t *current = typo->rows + typo->row_capacity;
  size_t width = typo->value.length;
  for (size_t j = 0; j <= width; j++) {
    previous[j] = j <= tolerance ? (uint32_t)j : beyond;
    current[j] = beyond;
  }
  for (size_t i = 1; i <= query->length; i++) {
    size_t low = i > tolerance ? i - tolerance : 1;
    size_t high = i + tolerance < width ? i + tolerance : width;
    current[low - 1] = low == 1 ? (uint32_t)i : beyond;
    uint32_t smallest = current[low - 1];
    if (high >= low && work_tally_add(tally, high - low + 1) != NARSIL_OK) { return 0; }
    for (size_t j = low; j <= high; j++) {
      uint32_t substitution = previous[j - 1] + (uint32_t)(query->values[i - 1] != typo->value.values[j - 1]);
      uint32_t cell = minimum(minimum(previous[j] + 1, current[j - 1] + 1), minimum(substitution, beyond));
      current[j] = cell;
      smallest = minimum(smallest, cell);
    }
    if (smallest > tolerance) { return 0; }
    uint32_t *finished = previous;
    previous = current;
    current = finished;
  }
  return previous[width] <= tolerance;
}

int pattern_typo_match(pattern_typo *typo, pattern_text_cursor *value, work_tally *tally) {
  const narsil_code_points *query = typo->case_fold != 0 ? &typo->folded : &typo->raw;
  size_t longest = query->length + typo->tolerance;
  size_t shortest = query->length > typo->tolerance ? query->length - typo->tolerance : 0;
  typo->value.length = 0;
  uint32_t point = 0;
  while (pattern_text_next(value, &point)) {
    if (typo->value.length == longest) { return 0; }
    typo->value.values[typo->value.length++] = point;
  }
  if (typo->value.length < shortest) { return 0; }
  return distance_within(typo, query, tally);
}
