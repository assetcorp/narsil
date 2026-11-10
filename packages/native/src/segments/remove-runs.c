#include "runs.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_segments.h"
#include "../terms/table.h"
#include "pools.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

static uint32_t find_run(const narsil_run_table *table, const uint32_t points[SEGMENT_RUN_POINTS]) {
  size_t mask = table->slot_capacity - 1;
  size_t slot = segment_run_hash(points) & mask;
  for (size_t scanned = 0; scanned < table->slot_capacity; scanned++) {
    int32_t entry = table->slots[slot];
    if (entry == 0) { return UINT32_MAX; }
    if (entry > 0 && (uint32_t)entry <= table->header[TERM_COUNT] &&
        segment_run_equal(points, table->runs + ((size_t)(entry - 1) * SEGMENT_RUN_POINTS))) {
      return (uint32_t)entry - 1;
    }
    slot = (slot + 1) & mask;
  }
  return UINT32_MAX;
}

static int has_spelling(const segment_run_member *members, size_t count, uint32_t spelling) {
  size_t low = 0;
  size_t high = count;
  while (low < high) {
    size_t middle = low + ((high - low) / 2);
    if (members[middle].spelling < spelling) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low < count && members[low].spelling == spelling;
}

static narsil_status check_members(const narsil_run_table *table, uint32_t ordinal, const segment_run_member *members,
                                   size_t count) {
  uint32_t start = table->list_start[ordinal];
  uint32_t length = table->list_length[ordinal];
  uint32_t end = table->allocator.allocation[SEGMENT_POOL_END];
  uint8_t kind = table->list_class[ordinal];
  if (end > table->member_capacity || start > end || kind >= table->allocator.class_count ||
      length > table->allocator.slice_capacities[kind] || table->allocator.slice_capacities[kind] > end - start) {
    return NARSIL_INVALID_ARGUMENT;
  }
  size_t found = 0;
  for (size_t at = start; at < (size_t)start + length; at++) {
    uint32_t spelling = table->members[at];
    if (at > start && spelling <= table->members[at - 1]) { return NARSIL_INVALID_ARGUMENT; }
    if (found < count && spelling == members[found].spelling) { found++; }
  }
  return found == count ? NARSIL_OK : NARSIL_INVALID_ARGUMENT;
}

static int order_slices(const segment_run_change *first, const segment_run_change *second) {
  return first->source.start < second->source.start ? -1 : first->source.start > second->source.start;
}

static int compare_slices(const void *left, const void *right) { return order_slices(left, right); }

narsil_status segment_runs_prepare_removal(segment_run_plan *plan, const narsil_run_table *table) {
  plan->change_count = 0;
  size_t start = 0;
  while (start < plan->count) {
    size_t end = start + 1;
    while (end < plan->count && segment_run_equal(plan->members[start].points, plan->members[end].points)) { end++; }
    uint32_t ordinal = find_run(table, plan->members[start].points);
    if (ordinal == UINT32_MAX) { return NARSIL_INVALID_ARGUMENT; }
    narsil_status status = check_members(table, ordinal, plan->members + start, end - start);
    if (status != NARSIL_OK) { return status; }
    uint8_t kind = table->list_class[ordinal];
    plan->changes[plan->change_count++] =
        (segment_run_change){.start = start,
                             .length = end - start,
                             .ordinal = ordinal,
                             .source = {table->list_start[ordinal], table->allocator.slice_capacities[kind], kind}};
    start = end;
  }
  if (plan->change_count > 1) {
    qsort(plan->changes, plan->change_count, sizeof *plan->changes, compare_slices);
    for (size_t at = 1; at < plan->change_count; at++) {
      segment_slice previous = plan->changes[at - 1].source;
      if (previous.start + previous.length > plan->changes[at].source.start) { return NARSIL_INVALID_ARGUMENT; }
    }
  }
  return NARSIL_OK;
}

static void remove_members(narsil_run_table *table, uint32_t ordinal, const segment_run_member *members, size_t count) {
  uint32_t start = table->list_start[ordinal];
  uint32_t length = table->list_length[ordinal];
  uint32_t kept = 0;
  for (size_t index = start; index < (size_t)start + length; index++) {
    uint32_t spelling = table->members[index];
    if (!has_spelling(members, count, spelling)) { table->members[start + kept++] = spelling; }
  }
  table->list_length[ordinal] = kept;
}

void segment_runs_remove(const segment_run_plan *plan, narsil_run_table *table) {
  for (size_t at = 0; at < plan->change_count; at++) {
    const segment_run_change *change = plan->changes + at;
    remove_members(table, change->ordinal, plan->members + change->start, change->length);
  }
}
