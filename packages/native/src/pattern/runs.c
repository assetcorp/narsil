#include "runs.h"

#include "constants.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

static int compare_run(const uint32_t *left, const uint32_t *right) {
  for (uint32_t at = 0; at < PATTERN_RUN_POINTS; at++) {
    if (left[at] != right[at]) { return left[at] < right[at] ? -1 : 1; }
  }
  return 0;
}

pattern_list pattern_postings(const pattern_index *index, const uint32_t *run) {
  pattern_list empty = {NULL, 0};
  size_t low = 0;
  size_t high = index->runs.count / PATTERN_RUN_POINTS;
  while (low < high) {
    size_t middle = low + ((high - low) / 2);
    int order = compare_run(index->runs.values + (middle * PATTERN_RUN_POINTS), run);
    if (order < 0) {
      low = middle + 1;
    } else if (order > 0) {
      high = middle;
    } else {
      if (middle + 1 >= index->offsets.count) { return empty; }
      uint32_t start = index->offsets.values[middle];
      uint32_t end = index->offsets.values[middle + 1];
      if (start >= end || end > index->postings.count) { return empty; }
      pattern_list list = {index->postings.values + start, (size_t)end - start};
      return list;
    }
  }
  return empty;
}

void pattern_keep_run(pattern_runs *runs, const uint32_t *points) {
  for (uint32_t at = 0; at < runs->count; at++) {
    if (compare_run(runs->points + ((size_t)at * PATTERN_RUN_POINTS), points) == 0) { return; }
  }
  if (runs->count == PATTERN_SHORTLIST_RUNS) { return; }
  memcpy(runs->points + ((size_t)runs->count * PATTERN_RUN_POINTS), points, PATTERN_RUN_POINTS * sizeof *points);
  runs->count++;
}

static size_t run_count(pattern_list factor) {
  return factor.count < PATTERN_RUN_POINTS ? 0 : factor.count - PATTERN_RUN_POINTS + 1;
}

void pattern_spread_runs(pattern_runs *into, const pattern_list *factors, size_t count) {
  uint64_t total = 0;
  into->count = 0;
  for (size_t at = 0; at < count; at++) { total += run_count(factors[at]); }
  if (total == 0) { return; }
  uint32_t picks = total < PATTERN_SHORTLIST_RUNS ? (uint32_t)total : PATTERN_SHORTLIST_RUNS;
  size_t factor = 0;
  uint64_t start = 0;
  for (uint32_t pick = 0; pick < picks; pick++) {
    uint64_t target = picks == 1 ? 0 : (((uint64_t)pick * (total - 1)) + ((picks - 1) / 2)) / (picks - 1);
    size_t length = run_count(factors[factor]);
    while (target >= start + length) {
      start += length;
      factor++;
      length = run_count(factors[factor]);
    }
    pattern_keep_run(into, factors[factor].values + (size_t)(target - start));
  }
}
