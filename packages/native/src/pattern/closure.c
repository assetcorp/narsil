#include "simulation.h"

#include "program.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

static void push_state(uint32_t state, pattern_simulation *scratch, size_t *depth) {
  if (scratch->marks.values[state] == scratch->stamp) { return; }
  scratch->marks.values[state] = scratch->stamp;
  scratch->stack.values[(*depth)++] = state;
}

static void advance_stamp(const pattern_program *program, pattern_simulation *scratch) {
  if (scratch->stamp == UINT32_MAX) {
    memset(scratch->marks.values, 0, program->count * sizeof *scratch->marks.values);
    scratch->stamp = 0;
  }
  scratch->stamp++;
}

int32_t pattern_close(const pattern_program *program, pattern_simulation *scratch,
                      const pattern_closure_request *request) {
  advance_stamp(program, scratch);
  size_t depth = 0;
  for (size_t at = 0; at < request->count; at++) {
    push_state(program->states[request->seeds[at]].next, scratch, &depth);
  }
  if (request->from_start != 0) { push_state(program->start, scratch, &depth); }
  int32_t count = 0;
  while (depth > 0) {
    uint32_t index = scratch->stack.values[--depth];
    const pattern_state *state = program->states + index;
    if (state->kind == PATTERN_CONSUME_STATE) {
      scratch->candidates.values[count++] = index;
      continue;
    }
    if (state->kind == PATTERN_MATCH_STATE) { return PATTERN_MATCH_REACHED; }
    if (state->kind == PATTERN_ASSERT_STATE && ((state->mask >> request->context) & 1) == 0) { continue; }
    push_state(state->next, scratch, &depth);
    if (state->kind == PATTERN_SPLIT_STATE) { push_state(state->alternative, scratch, &depth); }
  }
  return count;
}

uint32_t pattern_point_kind(uint32_t point) {
  return ((point >= '0' && point <= '9') || (point >= 'A' && point <= 'Z') || (point >= 'a' && point <= 'z') ||
          point == '_')
             ? 1U
             : 2U;
}
