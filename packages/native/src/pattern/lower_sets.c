#include "lower.h"

#include "../../include/narsil_core.h"
#include "ast.h"
#include "positions.h"

#include <stddef.h>
#include <stdint.h>

static uint32_t copy_set(pattern_lowering *lowering, uint32_t index) {
  const pattern_ast *source = lowering->source;
  pattern_ast *plan = lowering->plan;
  uint32_t set = pattern_node_add(plan, PATTERN_SET, source->nodes[index].value);
  for (uint32_t item = source->nodes[index].first; item != PATTERN_NO_NODE && plan->status == NARSIL_OK;
       item = source->nodes[item].next) {
    const pattern_node *before = source->nodes + item;
    uint32_t copied = pattern_node_add(plan, before->kind, before->value);
    if (plan->status != NARSIL_OK) { break; }
    plan->nodes[copied].minimum = before->minimum;
    plan->nodes[copied].maximum = before->maximum;
    pattern_node_append(plan, set, copied);
  }
  return set;
}

uint32_t pattern_lower_set(pattern_lowering *lowering, uint32_t index) {
  pattern_ast *plan = lowering->plan;
  uint32_t set = copy_set(lowering, index);
  if (plan->status != NARSIL_OK || lowering->case_fold == 0 || lowering->source->nodes[index].value != 0) {
    return set;
  }
  plan->status = pattern_multi_folds(lowering->source, index, lowering->folds);
  if (plan->status != NARSIL_OK || lowering->folds->length == 0) { return set; }
  uint32_t choice = pattern_node_add(plan, PATTERN_CHOICE, 0);
  pattern_node_append(plan, choice, set);
  for (size_t at = 0; at < lowering->folds->length && plan->status == NARSIL_OK; at += PATTERN_FOLD_WORDS) {
    const uint32_t *fold = lowering->folds->values + at;
    uint32_t sequence = pattern_node_add(plan, PATTERN_SEQUENCE, 0);
    for (uint32_t point = 0; point < fold[0]; point++) {
      pattern_node_append(plan, sequence, pattern_node_add(plan, PATTERN_LITERAL, fold[(size_t)point + 1]));
    }
    pattern_node_append(plan, choice, sequence);
  }
  return choice;
}
