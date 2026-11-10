#include "ast.h"

#include "../../include/narsil_core.h"
#include "../allocation.h"
#include "constants.h"

#include <stddef.h>
#include <stdint.h>

static int reserve_node(pattern_ast *tree) {
  if (tree->count < tree->capacity) { return 1; }
  size_t limit = SIZE_MAX / sizeof *tree->nodes;
  if (limit > UINT32_MAX) { limit = UINT32_MAX; }
  if (tree->count >= limit) {
    tree->status = NARSIL_OUT_OF_MEMORY;
    return 0;
  }
  size_t capacity = tree->capacity == 0 ? PATTERN_AST_INITIAL_CAPACITY : tree->capacity;
  if (capacity <= tree->count) { capacity = capacity <= limit / 2 ? capacity * 2 : limit; }
  pattern_node *nodes = core_reallocate(tree->nodes, capacity * sizeof *nodes);
  if (nodes == NULL) {
    tree->status = NARSIL_OUT_OF_MEMORY;
    return 0;
  }
  tree->nodes = nodes;
  tree->capacity = capacity;
  return 1;
}

uint32_t pattern_node_add(pattern_ast *tree, uint32_t kind, uint32_t value) {
  if (tree->status != NARSIL_OK || !reserve_node(tree)) { return PATTERN_NO_NODE; }
  uint32_t index = (uint32_t)tree->count++;
  pattern_node node = {kind, value, 0, 0, PATTERN_NO_NODE, PATTERN_NO_NODE, PATTERN_NO_NODE};
  tree->nodes[index] = node;
  return index;
}

void pattern_node_append(pattern_ast *tree, uint32_t parent, uint32_t child) {
  if (tree->status != NARSIL_OK) { return; }
  if (parent >= tree->count || child >= tree->count || parent == child) {
    tree->status = NARSIL_INVALID_ARGUMENT;
    return;
  }
  pattern_node *node = tree->nodes + parent;
  if (node->last == PATTERN_NO_NODE) {
    node->first = child;
  } else {
    tree->nodes[node->last].next = child;
  }
  node->last = child;
}

uint32_t pattern_node_finish(const pattern_ast *tree, uint32_t parent) {
  if (tree->status != NARSIL_OK || parent >= tree->count) { return PATTERN_NO_NODE; }
  const pattern_node *node = tree->nodes + parent;
  return node->first != PATTERN_NO_NODE && node->first == node->last ? node->first : parent;
}

uint32_t pattern_node_repeat(pattern_ast *tree, uint32_t body, pattern_bounds bounds) {
  uint32_t repeated = pattern_node_add(tree, PATTERN_REPEAT, 0);
  pattern_node_append(tree, repeated, body);
  if (tree->status == NARSIL_OK) {
    tree->nodes[repeated].minimum = bounds.minimum;
    tree->nodes[repeated].maximum = bounds.maximum;
  }
  return repeated;
}

uint32_t pattern_node_range(pattern_ast *tree, pattern_bounds bounds) {
  uint32_t range = pattern_node_add(tree, PATTERN_SET_RANGE, 0);
  if (tree->status == NARSIL_OK) {
    tree->nodes[range].minimum = bounds.minimum;
    tree->nodes[range].maximum = bounds.maximum;
  }
  uint32_t set = pattern_node_add(tree, PATTERN_SET, 0);
  pattern_node_append(tree, set, range);
  return set;
}
