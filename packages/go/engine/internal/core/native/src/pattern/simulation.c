#include "simulation.h"

#include "../../include/narsil_core.h"
#include "../analysis/text.h"
#include "constants.h"
#include "predicates.h"
#include "program.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

static int32_t start_closure(const pattern_program *program, pattern_simulation *scratch, uint32_t context) {
  int32_t known = scratch->start_counts[context];
  if (known != PATTERN_CLOSURE_UNKNOWN) { return known; }
  pattern_closure_request request = {NULL, 0, context, 1};
  int32_t count = pattern_close(program, scratch, &request);
  scratch->start_counts[context] = count;
  if (count > 0) {
    memcpy(scratch->starts.values + ((size_t)context * program->positions), scratch->candidates.values,
           (size_t)count * sizeof *scratch->starts.values);
  }
  return count;
}

static int32_t close_current(const pattern_program *program, pattern_simulation *scratch, uint32_t context) {
  int32_t start = 0;
  if (scratch->previous_kind == 0 || program->anchored_start == 0) {
    start = start_closure(program, scratch, context);
    if (start == PATTERN_MATCH_REACHED) { return start; }
  }
  pattern_closure_request request = {scratch->after.values, scratch->after.length, context, 0};
  int32_t count = pattern_close(program, scratch, &request);
  if (count == PATTERN_MATCH_REACHED) { return count; }
  for (int32_t at = 0; at < start; at++) {
    uint32_t position = scratch->starts.values[((size_t)context * program->positions) + (size_t)at];
    if (scratch->marks.values[position] == scratch->stamp) { continue; }
    scratch->marks.values[position] = scratch->stamp;
    scratch->candidates.values[count++] = position;
  }
  return count;
}

narsil_status pattern_simulation_prepare(pattern_program *program, pattern_simulation *scratch) {
  if (program->positions > PATTERN_MAX_POSITIONS || program->count == 0 || program->start >= program->count) {
    return NARSIL_INVALID_ARGUMENT;
  }
  narsil_code_points *regions[] = {&scratch->marks, &scratch->stack, &scratch->candidates, &scratch->after,
                                   &scratch->starts};
  size_t lengths[] = {program->count, program->count, program->positions, program->positions,
                      (size_t)program->positions * PATTERN_CONTEXTS};
  for (size_t at = 0; at < sizeof regions / sizeof regions[0]; at++) {
    int status = narsil_code_points_reserve(regions[at], lengths[at]);
    if (status != NARSIL_OK) { return (narsil_status)status; }
  }
  memset(scratch->marks.values, 0, program->count * sizeof *scratch->marks.values);
  scratch->stamp = 0;
  for (size_t at = 0; at < PATTERN_CONTEXTS; at++) { scratch->start_counts[at] = PATTERN_CLOSURE_UNKNOWN; }
  program->anchored_start = 1;
  for (uint32_t context = PATTERN_EDGE_KINDS; context < PATTERN_CONTEXTS; context++) {
    if (start_closure(program, scratch, context) != 0) { program->anchored_start = 0; }
  }
  pattern_simulation_reset(scratch);
  return NARSIL_OK;
}

void pattern_simulation_reset(pattern_simulation *scratch) {
  scratch->after.length = 0;
  scratch->previous_kind = 0;
  scratch->steps = 0;
}

static int accepts(uint32_t point, const pattern_program *program, uint32_t position) {
  const pattern_state *state = program->states + position;
  if (state->test == PATTERN_LITERAL_TEST) { return state->literal == point; }
  if (state->test == PATTERN_ANY_TEST) { return 1; }
  const pattern_predicate *predicate = &state->predicate;
  int found = 0;
  if (predicate->count > 0) {
    found = pattern_ranges_contain(point, program->predicates.ranges.values + predicate->start, predicate->count);
  }
  return found != (predicate->negated != 0);
}

uint32_t pattern_simulation_step(const pattern_program *program, pattern_simulation *scratch, uint32_t point) {
  uint32_t following = pattern_point_kind(point);
  int32_t count = close_current(program, scratch, (scratch->previous_kind * PATTERN_EDGE_KINDS) + following);
  scratch->steps = 0;
  if (count == PATTERN_MATCH_REACHED) { return PATTERN_STEP_MATCHED; }
  scratch->steps = (uint32_t)count;
  size_t kept = 0;
  for (int32_t at = 0; at < count; at++) {
    uint32_t position = scratch->candidates.values[at];
    if (accepts(point, program, position)) { scratch->after.values[kept++] = position; }
  }
  scratch->after.length = kept;
  scratch->previous_kind = following;
  return kept == 0 && program->anchored_start != 0 ? PATTERN_STEP_DEAD : PATTERN_STEP_CONTINUES;
}

int pattern_simulation_end(const pattern_program *program, pattern_simulation *scratch) {
  return close_current(program, scratch, scratch->previous_kind * PATTERN_EDGE_KINDS) == PATTERN_MATCH_REACHED;
}
