#include "program.h"

#include "../../include/narsil_core.h"
#include "../analysis/text.h"
#include "constants.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

static int compare_points(const void *first, const void *second) {
  uint32_t left = *(const uint32_t *)first;
  uint32_t right = *(const uint32_t *)second;
  if (left == right) { return 0; }
  return left < right ? -1 : 1;
}

static uint32_t searched_class(const narsil_code_points *edges, uint32_t point) {
  size_t low = 0;
  size_t high = edges->length;
  while (low < high) {
    size_t middle = low + ((high - low) / 2);
    if (edges->values[middle] <= point) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return (uint32_t)low;
}

uint32_t pattern_class_of(const pattern_program *program, uint32_t point) {
  if (point < PATTERN_DIRECT_CLASS_POINTS) { return program->direct_classes[point]; }
  return searched_class(&program->class_edges, point);
}

narsil_status pattern_classes_prepare(pattern_program *program) {
  static const uint32_t word_edges[] = {'0', '9' + 1, 'A', 'Z' + 1, '_', '_' + 1, 'a', 'z' + 1};
  const narsil_code_points *ranges = &program->predicates.ranges;
  size_t word_count = sizeof word_edges / sizeof word_edges[0];
  uint64_t needed = word_count + (uint64_t)ranges->length + ((uint64_t)program->positions * 2);
  if (needed > UINT32_MAX || needed > SIZE_MAX) { return NARSIL_OUT_OF_MEMORY; }
  narsil_code_points *edges = &program->class_edges;
  int status = narsil_code_points_reserve(edges, (size_t)needed);
  if (status != NARSIL_OK) { return (narsil_status)status; }
  edges->length = 0;
  for (size_t at = 0; at < word_count; at++) { edges->values[edges->length++] = word_edges[at]; }
  for (size_t at = 0; at < ranges->length; at += 2) {
    edges->values[edges->length++] = ranges->values[at];
    edges->values[edges->length++] = ranges->values[at + 1] + 1;
  }
  for (size_t at = 0; at < program->count; at++) {
    const pattern_state *state = program->states + at;
    if (state->kind != PATTERN_CONSUME_STATE || state->test != PATTERN_LITERAL_TEST) { continue; }
    edges->values[edges->length++] = state->literal;
    edges->values[edges->length++] = state->literal + 1;
  }
  qsort(edges->values, edges->length, sizeof *edges->values, compare_points);
  size_t kept = 0;
  for (size_t at = 0; at < edges->length; at++) {
    if (kept == 0 || edges->values[at] != edges->values[kept - 1]) { edges->values[kept++] = edges->values[at]; }
  }
  edges->length = kept;
  for (uint32_t point = 0; point < PATTERN_DIRECT_CLASS_POINTS; point++) {
    program->direct_classes[point] = searched_class(edges, point);
  }
  return NARSIL_OK;
}
