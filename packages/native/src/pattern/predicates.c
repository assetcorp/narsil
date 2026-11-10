#include "predicates.h"

#include "../../include/narsil_core.h"
#include "../analysis/text.h"
#include "../sort/text.h"
#include "ast.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

static narsil_status append_range(narsil_code_points *into, pattern_bounds bounds) {
  if (into->length > SIZE_MAX - 2) { return NARSIL_OUT_OF_MEMORY; }
  int status = narsil_code_points_reserve(into, into->length + 2);
  if (status != NARSIL_OK) { return (narsil_status)status; }
  into->values[into->length++] = bounds.minimum;
  into->values[into->length++] = bounds.maximum;
  return NARSIL_OK;
}

static narsil_status append_class(narsil_code_points *into, uint32_t kind) {
  static const uint32_t digit[] = {'0', '9'};
  static const uint32_t word[] = {'0', '9', 'A', 'Z', '_', '_', 'a', 'z'};
  static const uint32_t space[] = {'\t', '\n', '\f', '\r', ' ', ' '};
  const uint32_t *ranges = digit;
  size_t count = sizeof digit / sizeof digit[0];
  if (kind == PATTERN_WORD_CLASS) {
    ranges = word;
    count = sizeof word / sizeof word[0];
  } else if (kind == PATTERN_SPACE_CLASS) {
    ranges = space;
    count = sizeof space / sizeof space[0];
  } else if (kind != PATTERN_DIGIT_CLASS) {
    return NARSIL_INVALID_ARGUMENT;
  }
  for (size_t at = 0; at < count; at += 2) {
    pattern_bounds bounds = {ranges[at], ranges[at + 1]};
    narsil_status status = append_range(into, bounds);
    if (status != NARSIL_OK) { return status; }
  }
  return NARSIL_OK;
}

static narsil_status append_set(const pattern_ast *plan, const pattern_node *node, narsil_code_points *into) {
  for (uint32_t child = node->first; child != PATTERN_NO_NODE; child = plan->nodes[child].next) {
    const pattern_node *item = plan->nodes + child;
    narsil_status status = NARSIL_OK;
    if (item->kind == PATTERN_CLASS) {
      status = append_class(into, item->value);
    } else {
      pattern_bounds bounds = {item->minimum, item->maximum};
      if (item->kind == PATTERN_LITERAL) {
        bounds.minimum = item->value;
        bounds.maximum = item->value;
      }
      status = append_range(into, bounds);
    }
    if (status != NARSIL_OK) { return status; }
  }
  return NARSIL_OK;
}

static int compare_ranges(const void *first, const void *second) {
  const uint32_t *left = first;
  const uint32_t *right = second;
  if (left[0] != right[0]) { return left[0] < right[0] ? -1 : 1; }
  if (left[1] != right[1]) { return left[1] < right[1] ? -1 : 1; }
  return 0;
}

static void merge_ranges(narsil_code_points *ranges) {
  if (ranges->length == 0) { return; }
  qsort(ranges->values, ranges->length / 2, 2 * sizeof *ranges->values, compare_ranges);
  size_t kept = 2;
  for (size_t at = 2; at < ranges->length; at += 2) {
    uint32_t low = ranges->values[at];
    uint32_t high = ranges->values[at + 1];
    if ((uint64_t)low <= (uint64_t)ranges->values[kept - 1] + 1) {
      if (high > ranges->values[kept - 1]) { ranges->values[kept - 1] = high; }
    } else {
      ranges->values[kept++] = low;
      ranges->values[kept++] = high;
    }
  }
  ranges->length = kept;
}

int pattern_ranges_contain(uint32_t point, const uint32_t *ranges, size_t count) {
  size_t low = 0;
  size_t high = count / 2;
  while (low < high) {
    size_t middle = low + ((high - low) / 2);
    if (point < ranges[middle * 2]) {
      high = middle;
    } else if (point > ranges[(middle * 2) + 1]) {
      low = middle + 1;
    } else {
      return 1;
    }
  }
  return 0;
}

static narsil_status add_fold_targets(narsil_code_points *ranges) {
  size_t original = ranges->length;
  for (size_t at = 0; at < narsil_case_fold_count; at++) {
    const uint32_t *fold = narsil_case_folds[at];
    if (fold[1] != 1 || !pattern_ranges_contain(fold[0], ranges->values, original)) { continue; }
    pattern_bounds bounds = {fold[2], fold[2]};
    narsil_status status = append_range(ranges, bounds);
    if (status != NARSIL_OK) { return status; }
  }
  merge_ranges(ranges);
  return NARSIL_OK;
}

narsil_status pattern_predicate_build(const pattern_ast *plan, uint32_t node, pattern_predicates *scratch,
                                      pattern_predicate *predicate, uint32_t case_fold) {
  narsil_code_points *ranges = &scratch->temporary;
  ranges->length = 0;
  const pattern_node *source = plan->nodes + node;
  narsil_status status =
      source->kind == PATTERN_CLASS ? append_class(ranges, source->value) : append_set(plan, source, ranges);
  if (status != NARSIL_OK) { return status; }
  merge_ranges(ranges);
  if (source->kind == PATTERN_SET && case_fold != 0) {
    status = add_fold_targets(ranges);
    if (status != NARSIL_OK) { return status; }
  }
  if (ranges->length > UINT32_MAX || scratch->ranges.length > UINT32_MAX - ranges->length) {
    return NARSIL_OUT_OF_MEMORY;
  }
  size_t start = scratch->ranges.length;
  int allocated = narsil_code_points_reserve(&scratch->ranges, start + ranges->length);
  if (allocated != NARSIL_OK) { return (narsil_status)allocated; }
  if (ranges->length > 0) {
    memcpy(scratch->ranges.values + start, ranges->values, ranges->length * sizeof *ranges->values);
  }
  scratch->ranges.length += ranges->length;
  pattern_predicate prepared = {(uint32_t)start, (uint32_t)ranges->length,
                                (uint32_t)(source->kind == PATTERN_SET && source->value != 0)};
  *predicate = prepared;
  return NARSIL_OK;
}
