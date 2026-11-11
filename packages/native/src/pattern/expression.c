#include "internal.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_pattern.h"
#include "ast.h"
#include "cache.h"
#include "constants.h"
#include "factors.h"
#include "lower.h"
#include "parse.h"
#include "positions.h"
#include "program.h"
#include "simulation.h"

#include <stddef.h>
#include <stdint.h>

static narsil_status prepare_runs(pattern_scratch *scratch, uint32_t root) {
  const pattern_ast *tree = &scratch->parsed;
  const pattern_node *node = tree->nodes + root;
  narsil_status status = pattern_reserve_branches(scratch, tree->count);
  if (status != NARSIL_OK) { return status; }
  scratch->branch_count = 0;
  if (node->kind != PATTERN_CHOICE) {
    status = pattern_factor_runs(tree, root, &scratch->factors, scratch->branches);
    if (status == NARSIL_OK && scratch->branches[0].count > 0) { scratch->branch_count = 1; }
    return status;
  }
  for (uint32_t branch = node->first; branch != PATTERN_NO_NODE; branch = tree->nodes[branch].next) {
    pattern_runs *runs = scratch->branches + scratch->branch_count;
    status = pattern_factor_runs(tree, branch, &scratch->factors, runs);
    if (status != NARSIL_OK) { return status; }
    if (runs->count == 0) {
      scratch->branch_count = 0;
      return NARSIL_OK;
    }
    scratch->branch_count++;
  }
  return NARSIL_OK;
}

static narsil_status prepare_program(pattern_scratch *scratch, const narsil_pattern_test *test, uint32_t root) {
  pattern_lowering lowering = {&scratch->parsed, &scratch->lowered, &scratch->mapping, &scratch->folds,
                               test->case_fold};
  narsil_status status = pattern_lower(&lowering, &scratch->order);
  if (status != NARSIL_OK) { return status; }
  uint32_t lowered_root = scratch->mapping.values[root];
  status = pattern_compile(&scratch->lowered, lowered_root, &scratch->compiler, &scratch->program, test->case_fold);
  if (status != NARSIL_OK) { return status; }
  status = pattern_simulation_prepare(&scratch->program, &scratch->simulation);
  if (status != NARSIL_OK) { return status; }
  return pattern_cache_prepare(&scratch->program, &scratch->simulation, &scratch->cache, test->matcher_bytes);
}

narsil_status pattern_prepare_expression(pattern_scratch *scratch, const narsil_pattern_test *test) {
  scratch->parsed.count = 0;
  scratch->parsed.status = NARSIL_OK;
  pattern_reader reader = {&scratch->parsed, scratch->raw.values, scratch->raw.length, 0};
  uint32_t root =
      test->operator_kind == NARSIL_PATTERN_REGEX ? pattern_parse_regex(&reader) : pattern_parse_wildcard(&reader);
  if (scratch->parsed.status != NARSIL_OK) { return scratch->parsed.status; }
  narsil_status status = pattern_tree_order(&scratch->parsed, root, &scratch->order);
  if (status != NARSIL_OK) { return status; }
  status =
      pattern_position_counts(&scratch->parsed, &scratch->order, test->case_fold, &scratch->positions, &scratch->folds);
  if (status != NARSIL_OK) { return status; }
  if (scratch->positions.values[root] > PATTERN_MAX_POSITIONS) { return NARSIL_INVALID_ARGUMENT; }
  status = prepare_runs(scratch, root);
  if (status != NARSIL_OK) { return status; }
  status = prepare_program(scratch, test, root);
  if (status == NARSIL_OK) { scratch->matcher = PATTERN_EXPRESSION_MATCHER; }
  return status;
}
