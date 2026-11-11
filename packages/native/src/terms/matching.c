#include "matching.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_terms.h"
#include "../analysis/text.h"
#include "dictionary.h"
#include "scratch.h"

#include <stddef.h>
#include <stdint.h>

int term_points(term_cursor cursor, narsil_code_points *points) {
  points->length = 0;
  uint32_t point = 0;
  int next = 0;
  size_t units = 0;
  while ((next = term_next(&cursor, &point)) > 0) {
    units += point > UINT16_MAX ? 2 : 1;
    if (units > TERM_TEXT_LIMIT) { return 0; }
    int status = narsil_code_points_push(points, point);
    if (status != NARSIL_OK) { return -status; }
  }
  return next < 0 ? 0 : 1;
}

int term_compare_query(term_cursor cursor, const narsil_code_points *query, size_t prefix, int *valid) {
  size_t position = 0;
  uint32_t point = 0;
  int comparison = 0;
  int next = 0;
  size_t units = 0;
  size_t required = prefix < query->length ? prefix : query->length;
  while ((next = term_next(&cursor, &point)) > 0) {
    if (comparison == 0) {
      if (position >= required && prefix > query->length) {
        comparison = 1;
      } else if (position < required && point != query->values[position]) {
        comparison = point < query->values[position] ? -1 : 1;
      }
    }
    position++;
    units += point > UINT16_MAX ? 2 : 1;
    if (units > TERM_TEXT_LIMIT) { break; }
  }
  *valid = next == 0 && units <= TERM_TEXT_LIMIT;
  return comparison == 0 && position < required ? -1 : comparison;
}

static uint32_t minimum(uint32_t left, uint32_t right) { return left < right ? left : right; }

int term_within_distance(term_scratch *scratch, uint32_t tolerance) {
  size_t columns = scratch->query.length;
  size_t rows = scratch->candidate.length;
  size_t difference = rows > columns ? rows - columns : columns - rows;
  if (difference > tolerance) { return 0; }
  if (tolerance >= columns && tolerance >= rows) { return 1; }
  if (columns + 1 > SIZE_MAX / 2) { return -NARSIL_INVALID_ARGUMENT; }
  int status = narsil_code_points_reserve(&scratch->rows, (columns + 1) * 2);
  if (status != NARSIL_OK) { return -status; }
  uint32_t *previous = scratch->rows.values;
  uint32_t *current = previous + columns + 1;
  uint32_t beyond = tolerance + 1;
  for (size_t column = 0; column <= columns; column++) {
    previous[column] = column <= tolerance ? (uint32_t)column : beyond;
    current[column] = beyond;
  }
  for (size_t row = 1; row <= rows; row++) {
    size_t low = row > tolerance ? row - tolerance : 1;
    size_t high = columns - minimum((uint32_t)columns, tolerance) < row ? columns : row + tolerance;
    current[low - 1] = low == 1 ? (uint32_t)row : beyond;
    uint32_t smallest = current[low - 1];
    for (size_t column = low; column <= high; column++) {
      uint32_t cost = scratch->candidate.values[row - 1] == scratch->query.values[column - 1] ? 0 : 1;
      uint32_t cell = minimum(previous[column] + 1, current[column - 1] + 1);
      cell = minimum(minimum(cell, previous[column - 1] + cost), beyond);
      current[column] = cell;
      smallest = minimum(smallest, cell);
    }
    if (smallest > tolerance) { return 0; }
    uint32_t *finished = previous;
    previous = current;
    current = finished;
  }
  return previous[columns] <= tolerance;
}

int term_matches(const narsil_term_lookup *request, term_scratch *scratch, uint32_t ordinal) {
  if (dictionary_frequency(request->dictionary, ordinal) == 0) { return 0; }
  term_cursor cursor;
  if (!dictionary_cursor(request->dictionary, ordinal, &cursor)) { return 0; }
  size_t prefix = scratch->query.length;
  if (request->operation == NARSIL_LOOKUP_TYPO && request->prefix_length < prefix) { prefix = request->prefix_length; }
  int valid = 0;
  if (term_compare_query(cursor, &scratch->query, prefix, &valid) != 0 || !valid) { return 0; }
  if (request->operation == NARSIL_LOOKUP_PREFIX) { return 1; }
  int status = term_points(cursor, &scratch->candidate);
  if (status != 1) { return status; }
  return term_within_distance(scratch, request->tolerance);
}
