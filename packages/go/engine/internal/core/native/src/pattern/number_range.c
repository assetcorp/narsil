#include "number_range.h"

#include "../../include/narsil_core.h"
#include "ast.h"
#include "constants.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

enum { DECIMAL_BASE = 10, LAST_DIGIT = 9 };

typedef struct {
  uint8_t low[PATTERN_MAX_NUMBER_RANGE_DIGITS];
  uint8_t high[PATTERN_MAX_NUMBER_RANGE_DIGITS];
  uint32_t width;
  uint32_t parent;
} range_task;

uint64_t pattern_digits_value(const pattern_digits *digits) {
  uint64_t value = 0;
  for (uint32_t at = 0; at < digits->count; at++) { value = (value * DECIMAL_BASE) + digits->digits[at]; }
  return value;
}

static void append_literal(pattern_ast *tree, uint32_t parent, uint8_t digit) {
  pattern_node_append(tree, parent, pattern_node_add(tree, PATTERN_LITERAL, (uint32_t)'0' + digit));
}

static uint32_t digit_range(pattern_ast *tree, pattern_bounds bounds) {
  bounds.minimum += '0';
  bounds.maximum += '0';
  return pattern_node_range(tree, bounds);
}

static int every_digit(uint8_t digit, const uint8_t *digits, uint32_t width) {
  for (uint32_t at = 0; at < width; at++) {
    if (digits[at] != digit) { return 0; }
  }
  return 1;
}

static int finish_range(pattern_ast *tree, const range_task *task) {
  if (memcmp(task->low, task->high, task->width) == 0) {
    for (uint32_t at = 0; at < task->width; at++) { append_literal(tree, task->parent, task->low[at]); }
    return 1;
  }
  if (every_digit(0, task->low, task->width) && every_digit(LAST_DIGIT, task->high, task->width)) {
    pattern_bounds digits = {0, LAST_DIGIT};
    uint32_t range = digit_range(tree, digits);
    if (task->width > 1) {
      pattern_bounds copies = {task->width, task->width};
      range = pattern_node_repeat(tree, range, copies);
    }
    pattern_node_append(tree, task->parent, range);
    return 1;
  }
  if (task->width == 1) {
    pattern_bounds digits = {task->low[0], task->high[0]};
    pattern_node_append(tree, task->parent, digit_range(tree, digits));
    return 1;
  }
  return 0;
}

static range_task tail_of(const range_task *task, uint32_t parent) {
  range_task tail = {{0}, {0}, task->width - 1, parent};
  memcpy(tail.low, task->low + 1, tail.width);
  memcpy(tail.high, task->high + 1, tail.width);
  return tail;
}

static void append_middle(pattern_ast *tree, const range_task *task, uint32_t choice) {
  if (task->low[0] + 1 >= task->high[0]) { return; }
  uint32_t sequence = pattern_node_add(tree, PATTERN_SEQUENCE, 0);
  pattern_node_append(tree, choice, sequence);
  pattern_bounds leading = {(uint32_t)task->low[0] + 1, (uint32_t)task->high[0] - 1};
  pattern_node_append(tree, sequence, digit_range(tree, leading));
  pattern_bounds digits = {0, LAST_DIGIT};
  for (uint32_t at = 1; at < task->width; at++) { pattern_node_append(tree, sequence, digit_range(tree, digits)); }
}

static void same_width(pattern_ast *tree, const range_task *first) {
  range_task pending[PATTERN_MAX_NUMBER_RANGE_DIGITS + 1];
  uint32_t count = 1;
  pending[0] = *first;
  while (count > 0 && tree->status == NARSIL_OK) {
    range_task task = pending[--count];
    if (finish_range(tree, &task)) { continue; }
    if (task.low[0] == task.high[0]) {
      append_literal(tree, task.parent, task.low[0]);
      pending[count++] = tail_of(&task, task.parent);
      continue;
    }
    uint32_t choice = pattern_node_add(tree, PATTERN_CHOICE, 0);
    pattern_node_append(tree, task.parent, choice);
    uint32_t lower = pattern_node_add(tree, PATTERN_SEQUENCE, 0);
    pattern_node_append(tree, choice, lower);
    append_literal(tree, lower, task.low[0]);
    append_middle(tree, &task, choice);
    uint32_t upper = pattern_node_add(tree, PATTERN_SEQUENCE, 0);
    pattern_node_append(tree, choice, upper);
    append_literal(tree, upper, task.high[0]);
    range_task low_tail = tail_of(&task, lower);
    range_task high_tail = tail_of(&task, upper);
    memset(low_tail.high, LAST_DIGIT, low_tail.width);
    memset(high_tail.low, 0, high_tail.width);
    pending[count++] = high_tail;
    pending[count++] = low_tail;
  }
}

static uint32_t digit_count(uint64_t value) {
  uint32_t width = 1;
  while (value >= DECIMAL_BASE) {
    value /= DECIMAL_BASE;
    width++;
  }
  return width;
}

static void write_digits(uint8_t *digits, uint32_t width, uint64_t value) {
  while (width > 0) {
    digits[--width] = (uint8_t)(value % DECIMAL_BASE);
    value /= DECIMAL_BASE;
  }
}

static void different_widths(pattern_ast *tree, uint32_t parent, const pattern_digits *low,
                             const pattern_digits *high) {
  uint64_t start = pattern_digits_value(low);
  uint64_t highest = pattern_digits_value(high);
  uint32_t width = digit_count(start);
  uint32_t widest = digit_count(highest);
  uint64_t next_width = 1;
  for (uint32_t at = 0; at < width; at++) { next_width *= DECIMAL_BASE; }
  uint32_t choice = pattern_node_add(tree, PATTERN_CHOICE, 0);
  pattern_node_append(tree, parent, choice);
  for (; width <= widest && tree->status == NARSIL_OK; width++) {
    uint64_t last = highest < next_width - 1 ? highest : next_width - 1;
    uint32_t sequence = pattern_node_add(tree, PATTERN_SEQUENCE, 0);
    pattern_node_append(tree, choice, sequence);
    range_task task = {{0}, {0}, width, sequence};
    write_digits(task.low, width, start);
    write_digits(task.high, width, last);
    same_width(tree, &task);
    start = next_width;
    next_width *= DECIMAL_BASE;
  }
}

uint32_t pattern_number_range(pattern_ast *tree, const pattern_digits *low, const pattern_digits *high) {
  if (low->count == 0 || high->count == 0 || low->count > PATTERN_MAX_NUMBER_RANGE_DIGITS ||
      high->count > PATTERN_MAX_NUMBER_RANGE_DIGITS || pattern_digits_value(low) > pattern_digits_value(high)) {
    tree->status = NARSIL_INVALID_ARGUMENT;
    return PATTERN_NO_NODE;
  }
  uint32_t root = pattern_node_add(tree, PATTERN_NUMBER_RANGE, 0);
  uint32_t sequence = pattern_node_add(tree, PATTERN_SEQUENCE, 0);
  pattern_node_append(tree, root, sequence);
  if (low->count != high->count) {
    different_widths(tree, sequence, low, high);
    return root;
  }
  range_task task = {{0}, {0}, low->count, sequence};
  memcpy(task.low, low->digits, low->count);
  memcpy(task.high, high->digits, high->count);
  same_width(tree, &task);
  return root;
}
