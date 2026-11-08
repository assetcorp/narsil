#include "positions.h"

#include "../../include/narsil_core.h"
#include "../analysis/text.h"
#include "ast.h"
#include "constants.h"
#include "text.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

static int fold_exists(const narsil_code_points *folds, const uint32_t *fold) {
  for (size_t at = 0; at < folds->length; at += PATTERN_FOLD_WORDS) {
    if (memcmp(folds->values + at, fold, PATTERN_FOLD_WORDS * sizeof *fold) == 0) { return 1; }
  }
  return 0;
}

narsil_status pattern_multi_folds(const pattern_ast *tree, uint32_t set, narsil_code_points *folds) {
  folds->length = 0;
  if (set >= tree->count) { return NARSIL_INVALID_ARGUMENT; }
  size_t visited = 0;
  for (uint32_t item = tree->nodes[set].first; item != PATTERN_NO_NODE; item = tree->nodes[item].next) {
    if (item >= tree->count || ++visited > tree->count) { return NARSIL_INVALID_ARGUMENT; }
    if (tree->nodes[item].kind != PATTERN_LITERAL) { continue; }
    uint32_t fold[PATTERN_FOLD_WORDS] = {0};
    fold[0] = pattern_fold_point(tree->nodes[item].value, fold + 1);
    if (fold[0] <= 1 || fold_exists(folds, fold)) { continue; }
    for (uint32_t at = 0; at < PATTERN_FOLD_WORDS; at++) {
      int status = narsil_code_points_push(folds, fold[at]);
      if (status != NARSIL_OK) { return (narsil_status)status; }
    }
  }
  return NARSIL_OK;
}

narsil_status pattern_tree_order(const pattern_ast *tree, uint32_t root, narsil_code_points *order) {
  if (root >= tree->count) { return NARSIL_INVALID_ARGUMENT; }
  int status = narsil_code_points_reserve(order, tree->count);
  if (status != NARSIL_OK) { return (narsil_status)status; }
  order->values[0] = root;
  order->length = 1;
  for (size_t at = 0; at < order->length; at++) {
    uint32_t parent = order->values[at];
    for (uint32_t child = tree->nodes[parent].first; child != PATTERN_NO_NODE; child = tree->nodes[child].next) {
      if (child >= tree->count || order->length == tree->count) { return NARSIL_INVALID_ARGUMENT; }
      order->values[order->length++] = child;
    }
  }
  return NARSIL_OK;
}

static uint32_t saturated(uint64_t positions) {
  return positions > PATTERN_MAX_POSITIONS ? PATTERN_MAX_POSITIONS + 1 : (uint32_t)positions;
}

static uint32_t children_positions(const pattern_ast *tree, const pattern_node *node,
                                   const narsil_code_points *counts) {
  uint32_t total = 0;
  for (uint32_t child = node->first; child != PATTERN_NO_NODE; child = tree->nodes[child].next) {
    total = saturated((uint64_t)total + counts->values[child]);
    if (total > PATTERN_MAX_POSITIONS) { break; }
  }
  return total;
}

static uint32_t leaf_positions(const pattern_node *node, uint32_t case_fold) {
  if (node->kind == PATTERN_ASSERT) { return 0; }
  if (node->kind != PATTERN_LITERAL || case_fold == 0) { return 1; }
  uint32_t fold[PATTERN_MAX_FOLD_LENGTH];
  return pattern_fold_point(node->value, fold);
}

static uint32_t repeat_copies(const pattern_node *node) {
  if (node->maximum != PATTERN_UNBOUNDED) { return node->maximum; }
  return node->minimum > 0 ? node->minimum : 1;
}

narsil_status pattern_position_counts(const pattern_ast *tree, const narsil_code_points *order, uint32_t case_fold,
                                      narsil_code_points *counts, narsil_code_points *folds) {
  int allocated = narsil_code_points_reserve(counts, tree->count);
  if (allocated != NARSIL_OK) { return (narsil_status)allocated; }
  for (size_t at = order->length; at > 0; at--) {
    uint32_t index = order->values[at - 1];
    if (index >= tree->count) { return NARSIL_INVALID_ARGUMENT; }
    const pattern_node *node = tree->nodes + index;
    uint32_t count = 0;
    if (node->kind == PATTERN_SEQUENCE || node->kind == PATTERN_CHOICE || node->kind == PATTERN_NUMBER_RANGE) {
      count = children_positions(tree, node, counts);
    } else if (node->kind == PATTERN_REPEAT) {
      if (node->first >= tree->count) { return NARSIL_INVALID_ARGUMENT; }
      count = saturated((uint64_t)repeat_copies(node) * counts->values[node->first]);
    } else if (node->kind == PATTERN_SET && node->value == 0 && case_fold != 0) {
      narsil_status status = pattern_multi_folds(tree, index, folds);
      if (status != NARSIL_OK) { return status; }
      count = 1;
      for (size_t fold = 0; fold < folds->length; fold += PATTERN_FOLD_WORDS) {
        count = saturated((uint64_t)count + folds->values[fold]);
      }
    } else {
      count = leaf_positions(node, case_fold);
    }
    counts->values[index] = count;
  }
  counts->length = tree->count;
  return NARSIL_OK;
}
