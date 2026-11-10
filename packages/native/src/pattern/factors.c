#include "factors.h"

#include "../../include/narsil_core.h"
#include "../allocation.h"
#include "../analysis/text.h"
#include "ast.h"
#include "constants.h"
#include "runs.h"
#include "text.h"

#include <stddef.h>
#include <stdint.h>

static narsil_status flush_factor(pattern_factors *scratch) {
  if (scratch->points.length - scratch->start >= PATTERN_RUN_POINTS) {
    if (scratch->points.length > UINT32_MAX) { return NARSIL_OUT_OF_MEMORY; }
    int status = narsil_code_points_push(&scratch->ends, (uint32_t)scratch->points.length);
    if (status != NARSIL_OK) { return (narsil_status)status; }
    scratch->start = scratch->points.length;
  } else {
    scratch->points.length = scratch->start;
  }
  return NARSIL_OK;
}

static narsil_status push_children(const pattern_ast *tree, const pattern_node *node, narsil_code_points *stack) {
  size_t start = stack->length;
  for (uint32_t child = node->first; child != PATTERN_NO_NODE; child = tree->nodes[child].next) {
    if (child >= tree->count || stack->length >= stack->capacity) { return NARSIL_INVALID_ARGUMENT; }
    stack->values[stack->length++] = child;
  }
  size_t end = stack->length;
  while (end > start + 1) {
    end--;
    uint32_t swapped = stack->values[start];
    stack->values[start++] = stack->values[end];
    stack->values[end] = swapped;
  }
  return NARSIL_OK;
}

static narsil_status push_repeat(const pattern_node *node, pattern_factors *scratch) {
  if (node->minimum == 1 && node->maximum == 1) {
    scratch->stack.values[scratch->stack.length++] = node->first;
    return NARSIL_OK;
  }
  narsil_status status = flush_factor(scratch);
  if (status != NARSIL_OK) { return status; }
  if (node->minimum > 0) {
    scratch->stack.values[scratch->stack.length++] = PATTERN_NO_NODE;
    scratch->stack.values[scratch->stack.length++] = node->first;
  }
  return NARSIL_OK;
}

static narsil_status visit_node(const pattern_ast *tree, const pattern_node *node, pattern_factors *scratch) {
  if (node->kind == PATTERN_LITERAL) {
    uint32_t folded[PATTERN_MAX_FOLD_LENGTH];
    uint32_t count = pattern_fold_point(node->value, folded);
    for (uint32_t at = 0; at < count; at++) {
      int status = narsil_code_points_push(&scratch->points, folded[at]);
      if (status != NARSIL_OK) { return (narsil_status)status; }
    }
    return NARSIL_OK;
  }
  if (node->kind == PATTERN_ASSERT) { return NARSIL_OK; }
  if (node->kind == PATTERN_SEQUENCE) { return push_children(tree, node, &scratch->stack); }
  if (node->kind == PATTERN_REPEAT) {
    if (scratch->stack.capacity - scratch->stack.length < 2) { return NARSIL_INVALID_ARGUMENT; }
    return push_repeat(node, scratch);
  }
  return flush_factor(scratch);
}

static narsil_status sample_factors(pattern_factors *scratch, pattern_runs *runs) {
  size_t count = scratch->ends.length;
  if (count > scratch->list_capacity) {
    if (count > SIZE_MAX / sizeof *scratch->lists) { return NARSIL_OUT_OF_MEMORY; }
    pattern_list *lists = core_reallocate(scratch->lists, count * sizeof *lists);
    if (lists == NULL) { return NARSIL_OUT_OF_MEMORY; }
    scratch->lists = lists;
    scratch->list_capacity = count;
  }
  size_t start = 0;
  for (size_t at = 0; at < count; at++) {
    size_t end = scratch->ends.values[at];
    pattern_list list = {scratch->points.values + start, end - start};
    scratch->lists[at] = list;
    start = end;
  }
  pattern_spread_runs(runs, scratch->lists, count);
  return NARSIL_OK;
}

narsil_status pattern_factor_runs(const pattern_ast *tree, uint32_t root, pattern_factors *scratch,
                                  pattern_runs *runs) {
  if (root >= tree->count || tree->count >= SIZE_MAX / 2) { return NARSIL_INVALID_ARGUMENT; }
  int allocated = narsil_code_points_reserve(&scratch->stack, tree->count + 1);
  if (allocated != NARSIL_OK) { return (narsil_status)allocated; }
  scratch->points.length = 0;
  scratch->ends.length = 0;
  scratch->start = 0;
  scratch->stack.length = 1;
  scratch->stack.values[0] = root;
  size_t visited = 0;
  while (scratch->stack.length > 0) {
    if (++visited > tree->count * 2) { return NARSIL_INVALID_ARGUMENT; }
    uint32_t node = scratch->stack.values[--scratch->stack.length];
    if (node != PATTERN_NO_NODE && node >= tree->count) { return NARSIL_INVALID_ARGUMENT; }
    narsil_status status =
        node == PATTERN_NO_NODE ? flush_factor(scratch) : visit_node(tree, tree->nodes + node, scratch);
    if (status != NARSIL_OK) { return status; }
  }
  narsil_status status = flush_factor(scratch);
  return status == NARSIL_OK ? sample_factors(scratch, runs) : status;
}
