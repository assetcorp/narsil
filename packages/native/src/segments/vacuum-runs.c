#include "vacuum-runs.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_segments.h"
#include "../segment_merge/internal.h"
#include "../terms/table.h"
#include "pools.h"
#include "runs.h"
#include "vacuum-strings.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

static narsil_status reserve(segment_run_vacuum *plan, const narsil_run_table *table) {
  narsil_status status =
      segment_merge_reserve((void **)&plan->runs, table->header[TERM_COUNT], &plan->run_capacity, sizeof *plan->runs);
  if (status != NARSIL_OK) { return status; }
  status = segment_merge_reserve((void **)&plan->slices, table->header[TERM_COUNT], &plan->slice_capacity,
                                 sizeof *plan->slices);
  if (status != NARSIL_OK) { return status; }
  return segment_merge_reserve((void **)&plan->members, table->allocator.allocation[SEGMENT_POOL_END],
                               &plan->member_capacity, sizeof *plan->members);
}

static int valid_slot(const narsil_run_table *table, uint32_t ordinal) {
  const uint32_t *points = table->runs + ((size_t)ordinal * SEGMENT_RUN_POINTS);
  size_t mask = table->slot_capacity - 1;
  size_t slot = segment_run_hash(points) & mask;
  for (size_t seen = 0; seen < table->slot_capacity; seen++) {
    int32_t entry = table->slots[slot];
    if (entry == 0) { return 0; }
    if (entry > 0 && (uint32_t)entry <= table->header[TERM_COUNT] &&
        segment_run_equal(points, table->runs + ((size_t)(entry - 1) * SEGMENT_RUN_POINTS))) {
      return (uint32_t)entry - 1 == ordinal;
    }
    slot = (slot + 1) & mask;
  }
  return 0;
}

static narsil_status collect(segment_run_vacuum *plan, const narsil_run_table *table,
                             const segment_string_vacuum *spellings, uint32_t ordinal) {
  uint32_t start = table->list_start[ordinal];
  uint32_t length = table->list_length[ordinal];
  uint32_t end = table->allocator.allocation[SEGMENT_POOL_END];
  uint8_t kind = table->list_class[ordinal];
  if (kind >= table->allocator.class_count || start > end || !valid_slot(table, ordinal)) {
    return NARSIL_INVALID_ARGUMENT;
  }
  uint32_t size = table->allocator.slice_capacities[kind];
  if (size > end - start || length > size) { return NARSIL_INVALID_ARGUMENT; }
  plan->slices[ordinal] = (segment_slice){start, size, kind};
  segment_vacuum_run run = {.start = (uint32_t)plan->member_count};
  memcpy(run.points, table->runs + ((size_t)ordinal * SEGMENT_RUN_POINTS), sizeof run.points);
  for (size_t at = start; at < (size_t)start + length; at++) {
    uint32_t member = table->members[at];
    if (member >= spellings->source_count || (at > start && table->members[at - 1] >= member)) {
      return NARSIL_INVALID_ARGUMENT;
    }
    uint32_t target = spellings->mapping[member];
    if (target == UINT32_MAX) { continue; }
    if (plan->member_count >= end) { return NARSIL_INVALID_ARGUMENT; }
    plan->members[plan->member_count++] = target;
    run.length++;
  }
  if (run.length == 0) { return NARSIL_OK; }
  while (run.slice_class < table->allocator.class_count &&
         table->allocator.slice_capacities[run.slice_class] < run.length) {
    run.slice_class++;
  }
  if (run.slice_class >= table->allocator.class_count ||
      table->allocator.slice_capacities[run.slice_class] > end - run.start) {
    return NARSIL_INVALID_ARGUMENT;
  }
  plan->member_count = (size_t)run.start + table->allocator.slice_capacities[run.slice_class];
  plan->runs[plan->count++] = run;
  return NARSIL_OK;
}

static int slice_order(const void *first, const void *second) {
  const segment_slice *left = first;
  const segment_slice *right = second;
  return left->start < right->start ? -1 : left->start > right->start;
}

narsil_status segment_run_vacuum_prepare(segment_run_vacuum *plan, const narsil_run_table *table,
                                         const segment_string_vacuum *spellings) {
  plan->count = 0;
  plan->member_count = 0;
  plan->source_count = table->header[TERM_COUNT];
  uint32_t end = table->allocator.allocation[SEGMENT_POOL_END];
  if (end > table->member_capacity || table->allocator.allocation[SEGMENT_POOL_FREE] > end) {
    return NARSIL_INVALID_ARGUMENT;
  }
  uint32_t previous = 0;
  for (size_t at = 0; at < table->allocator.class_count; at++) {
    if (table->allocator.slice_capacities[at] <= previous) { return NARSIL_INVALID_ARGUMENT; }
    previous = table->allocator.slice_capacities[at];
  }
  narsil_status status = reserve(plan, table);
  if (status != NARSIL_OK) { return status; }
  for (uint32_t at = 0; at < plan->source_count; at++) {
    status = collect(plan, table, spellings, at);
    if (status != NARSIL_OK) { return status; }
  }
  if (plan->count >= table->slot_capacity) { return NARSIL_INVALID_ARGUMENT; }
  if (plan->source_count > 1) { qsort(plan->slices, plan->source_count, sizeof *plan->slices, slice_order); }
  for (size_t at = 1; at < plan->source_count; at++) {
    if (plan->slices[at].start - plan->slices[at - 1].start < plan->slices[at - 1].length) {
      return NARSIL_INVALID_ARGUMENT;
    }
  }
  return NARSIL_OK;
}

void segment_run_vacuum_publish(const segment_run_vacuum *plan, narsil_run_table *table) {
  memset(table->slots, 0, table->slot_capacity * sizeof *table->slots);
  size_t mask = table->slot_capacity - 1;
  for (uint32_t at = 0; at < plan->count; at++) {
    segment_vacuum_run run = plan->runs[at];
    memcpy(table->runs + ((size_t)at * SEGMENT_RUN_POINTS), run.points, sizeof run.points);
    size_t slot = segment_run_hash(run.points) & mask;
    while (table->slots[slot] != 0) { slot = (slot + 1) & mask; }
    table->slots[slot] = (int32_t)at + 1;
    table->list_start[at] = run.start;
    table->list_length[at] = run.length;
    table->list_class[at] = run.slice_class;
    memcpy(table->members + run.start, plan->members + run.start, run.length * sizeof *table->members);
  }
  for (size_t at = plan->count; at < plan->source_count; at++) { table->list_length[at] = 0; }
  table->header[TERM_COUNT] = (uint32_t)plan->count;
  table->allocator.allocation[SEGMENT_POOL_END] = (uint32_t)plan->member_count;
  table->allocator.allocation[SEGMENT_POOL_FREE] = 0;
  for (size_t at = 0; at < table->allocator.class_count; at++) { table->allocator.free_heads[at] = UINT32_MAX; }
}

void segment_run_vacuum_release(segment_run_vacuum *plan) {
  free(plan->runs);
  free(plan->slices);
  free(plan->members);
  *plan = (segment_run_vacuum){0};
}

size_t segment_run_vacuum_bytes(const segment_run_vacuum *plan) {
  return (plan->run_capacity * sizeof *plan->runs) + (plan->slice_capacity * sizeof *plan->slices) +
         (plan->member_capacity * sizeof *plan->members);
}
