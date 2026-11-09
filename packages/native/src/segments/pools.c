#include "pools.h"

#include "../../include/narsil_core.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

enum { MIN_POOL_PLAN = 16, POOL_PLAN_GROWTH = 2 };

static size_t slots_for(size_t capacity) {
  size_t slots = POOL_PLAN_GROWTH;
  while (slots <= capacity) { slots *= POOL_PLAN_GROWTH; }
  return slots;
}

narsil_status segment_pool_reserve(segment_pool_plan *plan, size_t capacity) {
  plan->active_slots = 0;
  if (capacity <= plan->capacity) {
    plan->active_slots = slots_for(capacity);
    return NARSIL_OK;
  }
  if (capacity > UINT32_MAX || capacity > SIZE_MAX / sizeof(segment_slice)) { return NARSIL_OUT_OF_MEMORY; }
  size_t held = plan->capacity == 0 ? MIN_POOL_PLAN : plan->capacity;
  while (held < capacity) {
    if (held > UINT32_MAX / POOL_PLAN_GROWTH) {
      held = capacity;
      break;
    }
    held *= POOL_PLAN_GROWTH;
  }
  size_t used = POOL_PLAN_GROWTH;
  while (used <= held) {
    if (used > SIZE_MAX / POOL_PLAN_GROWTH) { return NARSIL_OUT_OF_MEMORY; }
    used *= POOL_PLAN_GROWTH;
  }
  if (held > SIZE_MAX / sizeof(segment_slice) ||
      used > (SIZE_MAX - (held * sizeof(segment_slice))) / sizeof(uint32_t)) {
    return NARSIL_OUT_OF_MEMORY;
  }
  segment_slice *slices = malloc(held * sizeof *slices);
  uint32_t *slots = malloc(used * sizeof *slots);
  if (slices == NULL || slots == NULL) {
    free(slices);
    free(slots);
    return NARSIL_OUT_OF_MEMORY;
  }
  free(plan->slices);
  free(plan->used);
  plan->slices = slices;
  plan->used = slots;
  plan->capacity = held;
  plan->used_capacity = used;
  plan->active_slots = slots_for(capacity);
  return NARSIL_OK;
}

narsil_status segment_pool_begin(segment_pool_plan *plan, const segment_pool *pool) {
  if (pool->capacity > UINT32_MAX || pool->class_count == 0 || pool->class_count > SEGMENT_SLICE_CLASSES ||
      pool->allocation == NULL || pool->free_heads == NULL || pool->slice_capacities == NULL ||
      (pool->capacity > 0 && pool->values == NULL) || pool->allocation[SEGMENT_POOL_END] > pool->capacity ||
      pool->allocation[SEGMENT_POOL_FREE] > pool->allocation[SEGMENT_POOL_END]) {
    return NARSIL_INVALID_ARGUMENT;
  }
  uint32_t previous = 0;
  for (size_t index = 0; index < pool->class_count; index++) {
    if (pool->slice_capacities[index] <= previous) { return NARSIL_INVALID_ARGUMENT; }
    previous = pool->slice_capacities[index];
  }
  memcpy(plan->heads, pool->free_heads, pool->class_count * sizeof *pool->free_heads);
  plan->end = pool->allocation[SEGMENT_POOL_END];
  plan->free_entries = pool->allocation[SEGMENT_POOL_FREE];
  plan->count = 0;
  if (plan->active_slots > plan->used_capacity) { plan->active_slots = plan->used_capacity; }
  if (plan->active_slots > 0) { memset(plan->used, 0, plan->active_slots * sizeof *plan->used); }
  return NARSIL_OK;
}

static int record_slice(segment_pool_plan *plan, segment_slice slice) {
  if (plan->count == plan->capacity || plan->count + 1 >= plan->active_slots) { return 0; }
  size_t mask = plan->active_slots - 1;
  size_t slot = slice.start & mask;
  while (plan->used[slot] != 0) {
    if (plan->slices[plan->used[slot] - 1].start == slice.start) { return 0; }
    slot = (slot + 1) & mask;
  }
  plan->slices[plan->count] = slice;
  plan->used[slot] = (uint32_t)++plan->count;
  return 1;
}

narsil_status segment_pool_allocate(segment_pool_plan *plan, const segment_pool *pool, uint32_t length,
                                    segment_slice *slice) {
  size_t low = 0;
  size_t high = pool->class_count;
  while (low < high) {
    size_t middle = low + ((high - low) / 2);
    if (pool->slice_capacities[middle] < length) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  if (low == pool->class_count || length == 0) { return NARSIL_INVALID_ARGUMENT; }
  uint32_t size = pool->slice_capacities[low];
  uint32_t start = plan->heads[low];
  int reused = start != UINT32_MAX;
  if (reused) {
    if (start >= pool->allocation[SEGMENT_POOL_END] || size > pool->allocation[SEGMENT_POOL_END] - start ||
        size > plan->free_entries) {
      return NARSIL_INVALID_ARGUMENT;
    }
  } else {
    start = plan->end;
    if (size > pool->capacity - start) { return NARSIL_NEEDS_ROOM; }
  }
  segment_slice prepared = {start, size, (uint8_t)low};
  if (!record_slice(plan, prepared)) { return NARSIL_INVALID_ARGUMENT; }
  if (reused) {
    plan->heads[low] = pool->values[start];
    plan->free_entries -= size;
  } else {
    plan->end += size;
  }
  *slice = prepared;
  return NARSIL_OK;
}

void segment_pool_publish(const segment_pool_plan *plan, const segment_pool *pool) {
  pool->allocation[SEGMENT_POOL_END] = plan->end;
  pool->allocation[SEGMENT_POOL_FREE] = plan->free_entries;
  memcpy(pool->free_heads, plan->heads, pool->class_count * sizeof *pool->free_heads);
}

static int order_slices(const segment_slice *first, const segment_slice *second) {
  return first->start < second->start ? -1 : first->start > second->start;
}

static int compare_slices(const void *left, const void *right) { return order_slices(left, right); }

narsil_status segment_pool_check(segment_pool_plan *plan) {
  if (plan->count > 1) { qsort(plan->slices, plan->count, sizeof *plan->slices, compare_slices); }
  for (size_t index = 1; index < plan->count; index++) {
    segment_slice previous = plan->slices[index - 1];
    if (plan->slices[index].start - previous.start < previous.length) { return NARSIL_INVALID_ARGUMENT; }
  }
  return NARSIL_OK;
}

void segment_pool_release_slice(const segment_pool *pool, segment_slice slice) {
  if (slice.slice_class == SEGMENT_NO_SLICE) { return; }
  pool->values[slice.start] = pool->free_heads[slice.slice_class];
  pool->free_heads[slice.slice_class] = slice.start;
  pool->allocation[SEGMENT_POOL_FREE] += slice.length;
}

narsil_status segment_pool_trim_class(const segment_pool *pool, uint8_t source, uint32_t kept, uint8_t *target) {
  uint32_t previous = 0;
  for (size_t at = 0; at <= source; at++) {
    if (pool->slice_capacities[at] <= previous) { return NARSIL_INVALID_ARGUMENT; }
    previous = pool->slice_capacities[at];
  }
  *target = source;
  uint8_t smaller = 0;
  while (smaller < source && pool->slice_capacities[smaller] < kept) { smaller++; }
  uint32_t remaining = pool->slice_capacities[source] - pool->slice_capacities[smaller];
  uint32_t pieces = 0;
  for (size_t at = (size_t)source + 1; at > 0; at--) {
    uint32_t size = pool->slice_capacities[at - 1];
    pieces += remaining / size;
    if (pieces > pool->class_count) { return NARSIL_OK; }
    remaining %= size;
  }
  if (remaining == 0) { *target = smaller; }
  return NARSIL_OK;
}

void segment_pool_trim_slice(const segment_pool *pool, segment_slice source, uint8_t target) {
  uint32_t held = pool->slice_capacities[target];
  uint32_t start = source.start + held;
  uint32_t remaining = source.length - held;
  for (size_t at = (size_t)source.slice_class + 1; at > 0 && remaining > 0; at--) {
    uint32_t size = pool->slice_capacities[at - 1];
    while (size <= remaining) {
      segment_pool_release_slice(pool, (segment_slice){start, size, (uint8_t)(at - 1)});
      start += size;
      remaining -= size;
    }
  }
}

void segment_pool_release(segment_pool_plan *plan) {
  free(plan->slices);
  free(plan->used);
  memset(plan, 0, sizeof *plan);
}

size_t segment_pool_bytes(const segment_pool_plan *plan) {
  return (plan->capacity * sizeof *plan->slices) + (plan->used_capacity * sizeof *plan->used);
}
