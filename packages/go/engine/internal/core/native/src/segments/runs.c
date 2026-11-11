#include "runs.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_segments.h"
#include "../terms/table.h"
#include "pools.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

static segment_pool run_pool(const narsil_run_table *table) {
  return (segment_pool){table->members,
                        table->member_capacity,
                        table->allocator.allocation,
                        table->allocator.free_heads,
                        table->allocator.slice_capacities,
                        table->allocator.class_count};
}

static size_t slot_position(const segment_run_plan *plan, size_t slot) {
  size_t position = slot & (plan->slot_capacity - 1);
  while (plan->slots[position] != 0 && plan->changes[plan->slots[position] - 1].slot != slot) {
    position = (position + 1) & (plan->slot_capacity - 1);
  }
  return position;
}

static narsil_status find_run(segment_run_plan *plan, const narsil_run_table *table, segment_run_change *change) {
  const uint32_t *points = plan->members[change->start].points;
  size_t mask = table->slot_capacity - 1;
  size_t slot = segment_run_hash(points) & mask;
  size_t available = SIZE_MAX;
  for (size_t scanned = 0; scanned < table->slot_capacity; scanned++) {
    if (plan->slots[slot_position(plan, slot)] == 0) {
      int32_t entry = table->slots[slot];
      if (entry > 0 && (uint32_t)entry <= table->header[TERM_COUNT] &&
          segment_run_equal(points, table->runs + ((size_t)(entry - 1) * SEGMENT_RUN_POINTS))) {
        change->ordinal = (uint32_t)entry - 1;
        change->slot = (uint32_t)slot;
        return NARSIL_OK;
      }
      if (entry <= 0) {
        if (available == SIZE_MAX) {
          available = slot;
        } else if (entry == 0) {
          size_t ordinal = (size_t)table->header[TERM_COUNT] + plan->added;
          if (ordinal >= table->capacity || ordinal >= INT32_MAX) { return NARSIL_NEEDS_ROOM; }
          change->ordinal = (uint32_t)ordinal;
          change->slot = (uint32_t)available;
          change->added = 1;
          plan->slots[slot_position(plan, available)] = (uint32_t)plan->change_count + 1;
          plan->added++;
          return NARSIL_OK;
        }
      }
    }
    slot = (slot + 1) & mask;
  }
  return NARSIL_NEEDS_ROOM;
}

static narsil_status previous_slice(segment_run_change *change, const narsil_run_table *table,
                                    const segment_pool *pool) {
  change->source = (segment_slice){0, 0, SEGMENT_NO_SLICE};
  if (change->added) { return NARSIL_OK; }
  uint32_t ordinal = change->ordinal;
  uint8_t slice_class = table->list_class[ordinal];
  uint32_t start = table->list_start[ordinal];
  if (slice_class >= pool->class_count || start > pool->allocation[SEGMENT_POOL_END]) {
    return NARSIL_INVALID_ARGUMENT;
  }
  uint32_t capacity = pool->slice_capacities[slice_class];
  uint32_t length = table->list_length[ordinal];
  if (capacity > pool->allocation[SEGMENT_POOL_END] - start || length > capacity) { return NARSIL_INVALID_ARGUMENT; }
  change->source = (segment_slice){start, capacity, slice_class};
  change->old_length = length;
  return NARSIL_OK;
}

narsil_status segment_runs_prepare(segment_run_plan *plan, const narsil_run_table *table) {
  narsil_status status = segment_pool_reserve(&plan->pool, plan->count);
  if (status != NARSIL_OK) { return status; }
  segment_pool pool = run_pool(table);
  status = segment_pool_begin(&plan->pool, &pool);
  if (status != NARSIL_OK) { return status; }
  size_t start = 0;
  while (start < plan->count) {
    size_t end = start + 1;
    while (end < plan->count && segment_run_equal(plan->members[start].points, plan->members[end].points)) { end++; }
    segment_run_change *change = plan->changes + plan->change_count;
    *change = (segment_run_change){.start = start, .length = end - start};
    status = find_run(plan, table, change);
    if (status != NARSIL_OK) { return status; }
    status = previous_slice(change, table, &pool);
    if (status != NARSIL_OK) { return status; }
    if (change->length > UINT32_MAX - change->old_length) { return NARSIL_NEEDS_ROOM; }
    uint32_t length = change->old_length + (uint32_t)change->length;
    change->target = change->source;
    if (length > change->source.length) {
      status = segment_pool_allocate(&plan->pool, &pool, length, &change->target);
      if (status != NARSIL_OK) { return status; }
    }
    plan->change_count++;
    start = end;
  }
  return segment_pool_check(&plan->pool);
}

void segment_runs_publish(const segment_run_plan *plan, narsil_run_table *table) {
  segment_pool pool = run_pool(table);
  segment_pool_publish(&plan->pool, &pool);
  for (size_t index = 0; index < plan->change_count; index++) {
    const segment_run_change *change = plan->changes + index;
    uint32_t ordinal = change->ordinal;
    if (change->added) {
      memcpy(table->runs + ((size_t)ordinal * SEGMENT_RUN_POINTS), plan->members[change->start].points,
             SEGMENT_RUN_POINTS * sizeof *table->runs);
      table->slots[change->slot] = (int32_t)ordinal + 1;
    }
    uint32_t target = change->target.start;
    if (change->old_length > 0 && target != change->source.start) {
      memmove(table->members + target, table->members + change->source.start,
              change->old_length * sizeof *table->members);
    }
    for (size_t member = 0; member < change->length; member++) {
      table->members[target + change->old_length + member] = plan->members[change->start + member].spelling;
    }
    table->list_start[ordinal] = target;
    table->list_length[ordinal] = change->old_length + (uint32_t)change->length;
    table->list_class[ordinal] = change->target.slice_class;
  }
  for (size_t index = 0; index < plan->change_count; index++) {
    const segment_run_change *change = plan->changes + index;
    if (change->source.slice_class != SEGMENT_NO_SLICE && change->source.start != change->target.start) {
      segment_pool_release_slice(&pool, change->source);
    }
  }
  table->header[TERM_COUNT] += plan->added;
}
