#ifndef NARSIL_PATTERN_AST_H
#define NARSIL_PATTERN_AST_H

#include "../../include/narsil_core.h"

#include <stddef.h>
#include <stdint.h>

enum {
  PATTERN_LITERAL,
  PATTERN_ANY,
  PATTERN_CLASS,
  PATTERN_SET,
  PATTERN_ASSERT,
  PATTERN_SEQUENCE,
  PATTERN_CHOICE,
  PATTERN_REPEAT,
  PATTERN_NUMBER_RANGE,
  PATTERN_SET_RANGE
};

enum { PATTERN_DIGIT_CLASS, PATTERN_WORD_CLASS, PATTERN_SPACE_CLASS };
enum { PATTERN_START_MASK = 7, PATTERN_END_MASK = 73, PATTERN_WORD_MASK = 170, PATTERN_ANY_MASK = 511 };

#define PATTERN_NO_NODE UINT32_MAX
#define PATTERN_UNBOUNDED UINT32_MAX

typedef struct {
  uint32_t minimum;
  uint32_t maximum;
} pattern_bounds;

typedef struct {
  uint32_t kind;
  uint32_t value;
  uint32_t minimum;
  uint32_t maximum;
  uint32_t first;
  uint32_t last;
  uint32_t next;
} pattern_node;

typedef struct {
  pattern_node *nodes;
  size_t count;
  size_t capacity;
  narsil_status status;
} pattern_ast;

uint32_t pattern_node_add(pattern_ast *tree, uint32_t kind, uint32_t value);
void pattern_node_append(pattern_ast *tree, uint32_t parent, uint32_t child);
uint32_t pattern_node_finish(const pattern_ast *tree, uint32_t parent);
uint32_t pattern_node_repeat(pattern_ast *tree, uint32_t body, pattern_bounds bounds);
uint32_t pattern_node_range(pattern_ast *tree, pattern_bounds bounds);

#endif
