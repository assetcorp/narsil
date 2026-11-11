#include "program.h"

#include "../../include/narsil_core.h"
#include "ast.h"

#include <stddef.h>
#include <stdint.h>

enum {
  COMPILE_ENTER,
  COMPILE_LIST_NEXT,
  COMPILE_LIST_RETURNED,
  COMPILE_LOOP_RETURNED,
  COMPILE_REPEAT_NEXT,
  COMPILE_OPTIONAL_RETURNED,
  COMPILE_REQUIRED_RETURNED
};

typedef struct {
  const pattern_ast *plan;
  pattern_compiler *compiler;
  pattern_program *program;
  size_t depth;
  uint32_t returned;
} program_builder;

static void push_frame(uint32_t node, program_builder *builder, uint32_t next) {
  if (node >= builder->plan->count || builder->depth == builder->compiler->capacity) {
    builder->program->status = NARSIL_INVALID_ARGUMENT;
    return;
  }
  pattern_compile_frame frame = {0};
  frame.node = node;
  frame.next = next;
  frame.entry = next;
  builder->compiler->frames[builder->depth++] = frame;
}

static void finish_frame(program_builder *builder, uint32_t entry) {
  builder->returned = entry;
  builder->depth--;
}

static void start_repeat(program_builder *builder, pattern_compile_frame *frame, const pattern_node *node) {
  frame->required = node->minimum;
  frame->phase = COMPILE_REPEAT_NEXT;
  if (node->maximum != PATTERN_UNBOUNDED) {
    frame->remaining = node->maximum - node->minimum;
    return;
  }
  pattern_bounds successors = {PATTERN_NO_NODE, frame->next};
  frame->loop = pattern_program_split(builder->program, successors);
  frame->phase = COMPILE_LOOP_RETURNED;
  push_frame(node->first, builder, frame->loop);
}

static void enter_node(program_builder *builder, pattern_compile_frame *frame, const pattern_node *node) {
  switch (node->kind) {
    case PATTERN_SEQUENCE:
    case PATTERN_CHOICE:
      frame->child = node->last;
      frame->phase = COMPILE_LIST_NEXT;
      if (node->kind == PATTERN_CHOICE) { frame->entry = PATTERN_NO_NODE; }
      return;
    case PATTERN_REPEAT:
      start_repeat(builder, frame, node);
      return;
    case PATTERN_ASSERT:
      if (node->value == PATTERN_ANY_MASK) {
        finish_frame(builder, frame->next);
        return;
      }
      break;
    case PATTERN_LITERAL:
    case PATTERN_ANY:
    case PATTERN_CLASS:
    case PATTERN_SET:
      break;
    default:
      builder->program->status = NARSIL_INVALID_ARGUMENT;
      return;
  }
  pattern_state state = builder->compiler->prepared[frame->node];
  state.next = frame->next;
  finish_frame(builder, pattern_program_add(builder->program, &state));
}

static void compile_list(program_builder *builder, pattern_compile_frame *frame, const pattern_node *node) {
  if (frame->phase == COMPILE_LIST_RETURNED) {
    if (node->kind == PATTERN_CHOICE && frame->entry != PATTERN_NO_NODE) {
      pattern_bounds successors = {builder->returned, frame->entry};
      frame->entry = pattern_program_split(builder->program, successors);
    } else {
      frame->entry = builder->returned;
    }
    frame->child = builder->compiler->previous.values[frame->child];
  }
  if (frame->child == PATTERN_NO_NODE) {
    finish_frame(builder, frame->entry == PATTERN_NO_NODE ? frame->next : frame->entry);
    return;
  }
  frame->phase = COMPILE_LIST_RETURNED;
  push_frame(frame->child, builder, node->kind == PATTERN_CHOICE ? frame->next : frame->entry);
}

static void compile_repeat(program_builder *builder, pattern_compile_frame *frame, const pattern_node *node) {
  switch (frame->phase) {
    case COMPILE_LOOP_RETURNED:
      builder->program->states[frame->loop].next = builder->returned;
      frame->entry = frame->required == 0 ? frame->loop : builder->returned;
      if (frame->required > 0) { frame->required--; }
      break;
    case COMPILE_OPTIONAL_RETURNED: {
      pattern_bounds successors = {builder->returned, frame->next};
      frame->entry = pattern_program_split(builder->program, successors);
      frame->remaining--;
      break;
    }
    case COMPILE_REQUIRED_RETURNED:
      frame->entry = builder->returned;
      frame->required--;
      break;
    default:
      break;
  }
  if (frame->remaining > 0) {
    frame->phase = COMPILE_OPTIONAL_RETURNED;
  } else if (frame->required > 0) {
    frame->phase = COMPILE_REQUIRED_RETURNED;
  } else {
    finish_frame(builder, frame->entry);
    return;
  }
  push_frame(node->first, builder, frame->entry);
}

narsil_status pattern_compile(const pattern_ast *plan, uint32_t root, pattern_compiler *compiler,
                              pattern_program *program, uint32_t case_fold) {
  narsil_status status = pattern_compile_prepare(plan, root, compiler, program, case_fold);
  if (status != NARSIL_OK) { return status; }
  pattern_state match = {0};
  match.kind = PATTERN_MATCH_STATE;
  uint32_t end = pattern_program_add(program, &match);
  program_builder builder = {plan, compiler, program, 0, end};
  push_frame(root, &builder, end);
  while (builder.depth > 0 && program->status == NARSIL_OK) {
    pattern_compile_frame *frame = compiler->frames + builder.depth - 1;
    const pattern_node *node = plan->nodes + frame->node;
    if (frame->phase == COMPILE_ENTER) {
      enter_node(&builder, frame, node);
    } else if (frame->phase == COMPILE_LIST_NEXT || frame->phase == COMPILE_LIST_RETURNED) {
      compile_list(&builder, frame, node);
    } else {
      compile_repeat(&builder, frame, node);
    }
  }
  if (program->status == NARSIL_OK) {
    program->start = builder.returned;
    program->status = pattern_classes_prepare(program);
  }
  return program->status;
}
