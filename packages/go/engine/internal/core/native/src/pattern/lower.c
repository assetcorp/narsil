#include "lower.h"

#include "../../include/narsil_core.h"
#include "../analysis/text.h"
#include "ast.h"
#include "constants.h"
#include "text.h"

#include <stddef.h>
#include <stdint.h>

static int is_loose(const pattern_node *node) {
  return node->kind == PATTERN_REPEAT && node->minimum <= 1 &&
         (node->maximum == 1 || node->maximum == PATTERN_UNBOUNDED);
}

static uint32_t lower_repeat(pattern_lowering *lowering, const pattern_node *node) {
  pattern_ast *plan = lowering->plan;
  if (node->maximum == 0) { return pattern_node_add(plan, PATTERN_ASSERT, PATTERN_ANY_MASK); }
  uint32_t body = lowering->mapping->values[node->first];
  pattern_node content = plan->nodes[body];
  if (content.kind == PATTERN_ASSERT) {
    return node->minimum == 0 ? pattern_node_add(plan, PATTERN_ASSERT, PATTERN_ANY_MASK) : body;
  }
  if (node->minimum == 1 && node->maximum == 1) { return body; }
  pattern_bounds bounds = {node->minimum, node->maximum};
  if (is_loose(node) && is_loose(&content)) {
    bounds.minimum = (uint32_t)(node->minimum != 0 && content.minimum != 0);
    bounds.maximum = node->maximum == PATTERN_UNBOUNDED || content.maximum == PATTERN_UNBOUNDED ? PATTERN_UNBOUNDED : 1;
    body = content.first;
  }
  return pattern_node_repeat(plan, body, bounds);
}

static uint32_t lower_literal(pattern_lowering *lowering, uint32_t point) {
  pattern_ast *plan = lowering->plan;
  if (lowering->case_fold == 0) { return pattern_node_add(plan, PATTERN_LITERAL, point); }
  uint32_t folded[PATTERN_MAX_FOLD_LENGTH];
  uint32_t count = pattern_fold_point(point, folded);
  uint32_t sequence = pattern_node_add(plan, PATTERN_SEQUENCE, 0);
  for (uint32_t at = 0; at < count; at++) {
    pattern_node_append(plan, sequence, pattern_node_add(plan, PATTERN_LITERAL, folded[at]));
  }
  return pattern_node_finish(plan, sequence);
}

static uint32_t lower_node(pattern_lowering *lowering, uint32_t index) {
  const pattern_node *node = lowering->source->nodes + index;
  switch (node->kind) {
    case PATTERN_LITERAL:
      return lower_literal(lowering, node->value);
    case PATTERN_SET:
      return pattern_lower_set(lowering, index);
    case PATTERN_SEQUENCE:
    case PATTERN_CHOICE:
      return pattern_lower_list(lowering, node);
    case PATTERN_REPEAT:
      return lower_repeat(lowering, node);
    case PATTERN_NUMBER_RANGE:
      return lowering->mapping->values[node->first];
    default:
      return pattern_node_add(lowering->plan, node->kind, node->value);
  }
}

narsil_status pattern_lower(pattern_lowering *lowering, const narsil_code_points *order) {
  int allocated = narsil_code_points_reserve(lowering->mapping, lowering->source->count);
  if (allocated != NARSIL_OK) { return (narsil_status)allocated; }
  lowering->plan->count = 0;
  lowering->plan->status = NARSIL_OK;
  for (size_t at = order->length; at > 0 && lowering->plan->status == NARSIL_OK; at--) {
    uint32_t index = order->values[at - 1];
    lowering->mapping->values[index] = lower_node(lowering, index);
  }
  lowering->mapping->length = lowering->source->count;
  return lowering->plan->status;
}
