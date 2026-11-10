#include "lower.h"

#include "../../include/narsil_core.h"
#include "ast.h"

#include <stdint.h>

typedef struct {
  pattern_ast *plan;
  uint32_t parent;
  uint32_t mask;
  int choice;
  int holds_assertion;
} list_builder;

static void append_detached(pattern_ast *tree, uint32_t parent, uint32_t child) {
  if (tree->status != NARSIL_OK) { return; }
  tree->nodes[child].next = PATTERN_NO_NODE;
  pattern_node_append(tree, parent, child);
}

static void append_assertion(list_builder *builder) {
  uint32_t assertion = pattern_node_add(builder->plan, PATTERN_ASSERT, builder->mask);
  pattern_node_append(builder->plan, builder->parent, assertion);
}

static void append_item(list_builder *builder, uint32_t item) {
  pattern_ast *tree = builder->plan;
  pattern_node node = tree->nodes[item];
  if (node.kind == PATTERN_ASSERT) {
    builder->mask = builder->choice != 0 ? builder->mask | node.value : builder->mask & node.value;
    builder->holds_assertion = 1;
    return;
  }
  if (builder->choice == 0 && builder->mask != PATTERN_ANY_MASK) {
    append_assertion(builder);
    builder->mask = PATTERN_ANY_MASK;
  }
  append_detached(tree, builder->parent, item);
}

uint32_t pattern_lower_list(pattern_lowering *lowering, const pattern_node *node) {
  pattern_ast *plan = lowering->plan;
  uint32_t parent = pattern_node_add(plan, node->kind, 0);
  int choice = node->kind == PATTERN_CHOICE;
  list_builder builder = {plan, parent, choice != 0 ? 0 : PATTERN_ANY_MASK, choice, 0};
  for (uint32_t child = node->first; child != PATTERN_NO_NODE && plan->status == NARSIL_OK;
       child = lowering->source->nodes[child].next) {
    uint32_t mapped = lowering->mapping->values[child];
    if (plan->nodes[mapped].kind != node->kind) {
      append_item(&builder, mapped);
      continue;
    }
    uint32_t nested = plan->nodes[mapped].first;
    while (nested != PATTERN_NO_NODE && plan->status == NARSIL_OK) {
      uint32_t next = plan->nodes[nested].next;
      append_item(&builder, nested);
      nested = next;
    }
  }
  if (plan->status != NARSIL_OK) { return PATTERN_NO_NODE; }
  if (plan->nodes[parent].first == PATTERN_NO_NODE) { return pattern_node_add(plan, PATTERN_ASSERT, builder.mask); }
  if ((choice != 0 && builder.holds_assertion != 0) || (choice == 0 && builder.mask != PATTERN_ANY_MASK)) {
    append_assertion(&builder);
  }
  return pattern_node_finish(plan, parent);
}
