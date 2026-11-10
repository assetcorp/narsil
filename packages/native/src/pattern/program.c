#include "program.h"

#include "../../include/narsil_core.h"
#include "../analysis/text.h"
#include "ast.h"
#include "constants.h"
#include "positions.h"
#include "predicates.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

uint32_t pattern_program_add(pattern_program *program, const pattern_state *state) {
  if (program->status != NARSIL_OK) { return PATTERN_NO_NODE; }
  if (program->count == program->capacity) {
    size_t limit = SIZE_MAX / sizeof *program->states;
    if (limit > UINT32_MAX) { limit = UINT32_MAX; }
    if (program->count >= limit) {
      program->status = NARSIL_OUT_OF_MEMORY;
      return PATTERN_NO_NODE;
    }
    size_t capacity = program->capacity == 0 ? PATTERN_AST_INITIAL_CAPACITY : program->capacity;
    if (capacity <= program->count) { capacity = capacity <= limit / 2 ? capacity * 2 : limit; }
    pattern_state *states = realloc(program->states, capacity * sizeof *states);
    if (states == NULL) {
      program->status = NARSIL_OUT_OF_MEMORY;
      return PATTERN_NO_NODE;
    }
    program->states = states;
    program->capacity = capacity;
  }
  uint32_t index = (uint32_t)program->count++;
  program->states[index] = *state;
  if (state->kind == PATTERN_CONSUME_STATE) { program->positions++; }
  return index;
}

uint32_t pattern_program_split(pattern_program *program, pattern_bounds successors) {
  pattern_state state = {0};
  state.kind = PATTERN_SPLIT_STATE;
  state.next = successors.minimum;
  state.alternative = successors.maximum;
  return pattern_program_add(program, &state);
}

static narsil_status reserve_compiler(pattern_compiler *compiler, size_t count) {
  if (count <= compiler->capacity) { return NARSIL_OK; }
  if (count > SIZE_MAX / sizeof *compiler->frames || count > SIZE_MAX / sizeof *compiler->prepared) {
    return NARSIL_OUT_OF_MEMORY;
  }
  pattern_compile_frame *frames = malloc(count * sizeof *frames);
  pattern_state *prepared = malloc(count * sizeof *prepared);
  if (frames == NULL || prepared == NULL) {
    free(frames);
    free(prepared);
    return NARSIL_OUT_OF_MEMORY;
  }
  free(compiler->frames);
  free(compiler->prepared);
  compiler->frames = frames;
  compiler->prepared = prepared;
  compiler->capacity = count;
  return NARSIL_OK;
}

static narsil_status prepare_node(const pattern_ast *plan, uint32_t index, pattern_compiler *compiler,
                                  pattern_program *program, uint32_t case_fold) {
  const pattern_node *node = plan->nodes + index;
  pattern_state state = {0};
  state.literal = node->value;
  if (node->kind == PATTERN_ASSERT) {
    state.kind = PATTERN_ASSERT_STATE;
    state.mask = node->value;
  } else if (node->kind == PATTERN_ANY) {
    state.test = PATTERN_ANY_TEST;
  } else if (node->kind == PATTERN_CLASS || node->kind == PATTERN_SET) {
    state.test = PATTERN_RANGE_TEST;
    narsil_status status = pattern_predicate_build(plan, index, &program->predicates, &state.predicate, case_fold);
    if (status != NARSIL_OK) { return status; }
  }
  compiler->prepared[index] = state;
  uint32_t previous = PATTERN_NO_NODE;
  for (uint32_t child = node->first; child != PATTERN_NO_NODE; child = plan->nodes[child].next) {
    compiler->previous.values[child] = previous;
    previous = child;
  }
  return NARSIL_OK;
}

narsil_status pattern_compile_prepare(const pattern_ast *plan, uint32_t root, pattern_compiler *compiler,
                                      pattern_program *program, uint32_t case_fold) {
  narsil_status status = pattern_tree_order(plan, root, &compiler->order);
  if (status != NARSIL_OK) { return status; }
  status = reserve_compiler(compiler, plan->count);
  if (status != NARSIL_OK) { return status; }
  int allocated = narsil_code_points_reserve(&compiler->previous, plan->count);
  if (allocated != NARSIL_OK) { return (narsil_status)allocated; }
  program->count = 0;
  program->positions = 0;
  program->status = NARSIL_OK;
  program->anchored_start = 0;
  program->predicates.ranges.length = 0;
  for (size_t at = 0; at < compiler->order.length; at++) {
    status = prepare_node(plan, compiler->order.values[at], compiler, program, case_fold);
    if (status != NARSIL_OK) { return status; }
  }
  return NARSIL_OK;
}
