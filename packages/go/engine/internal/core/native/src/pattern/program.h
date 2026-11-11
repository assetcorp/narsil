#ifndef NARSIL_PATTERN_PROGRAM_H
#define NARSIL_PATTERN_PROGRAM_H

#include "../../include/narsil_core.h"
#include "../analysis/text.h"
#include "ast.h"
#include "constants.h"
#include "predicates.h"

#include <stddef.h>
#include <stdint.h>

enum { PATTERN_CONSUME_STATE, PATTERN_SPLIT_STATE, PATTERN_ASSERT_STATE, PATTERN_MATCH_STATE };
enum { PATTERN_LITERAL_TEST, PATTERN_ANY_TEST, PATTERN_RANGE_TEST };

typedef struct {
  uint32_t kind;
  uint32_t next;
  uint32_t alternative;
  uint32_t mask;
  uint32_t test;
  uint32_t literal;
  pattern_predicate predicate;
} pattern_state;

typedef struct {
  uint32_t node;
  uint32_t next;
  uint32_t entry;
  uint32_t child;
  uint32_t remaining;
  uint32_t required;
  uint32_t loop;
  uint32_t phase;
} pattern_compile_frame;

typedef struct {
  pattern_state *states;
  size_t count;
  size_t capacity;
  uint32_t start;
  uint32_t positions;
  uint32_t anchored_start;
  pattern_predicates predicates;
  narsil_code_points class_edges;
  uint32_t direct_classes[PATTERN_DIRECT_CLASS_POINTS];
  narsil_status status;
} pattern_program;

typedef struct {
  pattern_compile_frame *frames;
  pattern_state *prepared;
  size_t capacity;
  narsil_code_points previous;
  narsil_code_points order;
} pattern_compiler;

narsil_status pattern_compile_prepare(const pattern_ast *plan, uint32_t root, pattern_compiler *compiler,
                                      pattern_program *program, uint32_t case_fold);
uint32_t pattern_program_add(pattern_program *program, const pattern_state *state);
uint32_t pattern_program_split(pattern_program *program, pattern_bounds successors);
narsil_status pattern_compile(const pattern_ast *plan, uint32_t root, pattern_compiler *compiler,
                              pattern_program *program, uint32_t case_fold);
narsil_status pattern_classes_prepare(pattern_program *program);
uint32_t pattern_class_of(const pattern_program *program, uint32_t point);

#endif
