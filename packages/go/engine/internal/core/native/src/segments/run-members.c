#include "runs.h"

#include "../../include/narsil_core.h"
#include "../analysis/text.h"
#include "pools.h"
#include "strings.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

enum { MIN_RUN_PLAN = 16, RUN_PLAN_GROWTH = 2, BYTES_PER_POINT = 4, BYTE_BITS = 8, BYTE_MASK = 255 };
#define RUN_FNV_OFFSET UINT32_C(0x811c9dc5)
#define RUN_FNV_PRIME UINT32_C(0x01000193)

uint32_t segment_run_hash(const uint32_t points[SEGMENT_RUN_POINTS]) {
  uint32_t hash = RUN_FNV_OFFSET;
  for (size_t index = 0; index < SEGMENT_RUN_POINTS; index++) {
    for (size_t byte = 0; byte < BYTES_PER_POINT; byte++) {
      hash = (hash ^ ((points[index] >> (byte * BYTE_BITS)) & BYTE_MASK)) * RUN_FNV_PRIME;
    }
  }
  return hash;
}

int segment_run_equal(const uint32_t left[SEGMENT_RUN_POINTS], const uint32_t right[SEGMENT_RUN_POINTS]) {
  for (size_t index = 0; index < SEGMENT_RUN_POINTS; index++) {
    if (left[index] != right[index]) { return 0; }
  }
  return 1;
}

static narsil_status reserve_runs(segment_run_plan *plan, size_t count) {
  if (count <= plan->capacity) { return NARSIL_OK; }
  size_t held = plan->capacity == 0 ? MIN_RUN_PLAN : plan->capacity;
  while (held < count) {
    if (held > INT32_MAX / RUN_PLAN_GROWTH) {
      held = count;
      break;
    }
    held *= RUN_PLAN_GROWTH;
  }
  if (held > INT32_MAX) { return NARSIL_OUT_OF_MEMORY; }
  size_t width = sizeof(segment_run_member) + sizeof(segment_run_change);
  size_t slots = RUN_PLAN_GROWTH;
  while (slots <= held) {
    if (slots > SIZE_MAX / RUN_PLAN_GROWTH) { return NARSIL_OUT_OF_MEMORY; }
    slots *= RUN_PLAN_GROWTH;
  }
  if (held > SIZE_MAX / width || slots > (SIZE_MAX - (held * width)) / sizeof(uint32_t)) {
    return NARSIL_OUT_OF_MEMORY;
  }
  segment_run_member *members = malloc(held * sizeof *members);
  segment_run_change *changes = malloc(held * sizeof *changes);
  uint32_t *positions = malloc(slots * sizeof *positions);
  if (members == NULL || changes == NULL || positions == NULL) {
    free(members);
    free(changes);
    free(positions);
    return NARSIL_OUT_OF_MEMORY;
  }
  free(plan->members);
  free(plan->changes);
  free(plan->slots);
  plan->members = members;
  plan->changes = changes;
  plan->slots = positions;
  plan->capacity = held;
  plan->slot_capacity = slots;
  return NARSIL_OK;
}

static int order_members(const segment_run_member *first, const segment_run_member *second) {
  for (size_t index = 0; index < SEGMENT_RUN_POINTS; index++) {
    if (first->points[index] != second->points[index]) { return first->points[index] < second->points[index] ? -1 : 1; }
  }
  return first->spelling < second->spelling ? -1 : first->spelling > second->spelling;
}

static int compare_members(const void *left, const void *right) { return order_members(left, right); }

narsil_status segment_runs_collect(segment_run_plan *plan, const segment_strings *spellings) {
  size_t count = 0;
  for (size_t index = 0; index < spellings->count; index++) {
    const segment_string *entry = spellings->entries + index;
    if (!entry->added || entry->points <= SEGMENT_RUN_POINTS) { continue; }
    size_t added = entry->points - SEGMENT_RUN_POINTS + 1;
    if (added > SIZE_MAX - count) { return NARSIL_OUT_OF_MEMORY; }
    count += added;
  }
  narsil_status status = reserve_runs(plan, count);
  if (status != NARSIL_OK) { return status; }
  plan->count = 0;
  plan->change_count = 0;
  plan->added = 0;
  if (plan->slot_capacity > 0) { memset(plan->slots, 0, plan->slot_capacity * sizeof *plan->slots); }
  for (size_t index = 0; index < spellings->count; index++) {
    const segment_string *entry = spellings->entries + index;
    if (!entry->added || entry->points <= SEGMENT_RUN_POINTS) { continue; }
    uint32_t points[SEGMENT_RUN_POINTS] = {0};
    size_t position = 0;
    size_t seen = 0;
    while (position < entry->length) {
      points[0] = points[1];
      points[1] = points[2];
      points[2] = narsil_decode_next(entry->text, entry->length, &position);
      if (++seen < SEGMENT_RUN_POINTS) { continue; }
      segment_run_member *member = plan->members + plan->count++;
      memcpy(member->points, points, sizeof points);
      member->spelling = entry->ordinal;
    }
  }
  if (plan->count > 1) { qsort(plan->members, plan->count, sizeof *plan->members, compare_members); }
  size_t kept = 0;
  for (size_t index = 0; index < plan->count; index++) {
    if (kept == 0 || compare_members(plan->members + index, plan->members + kept - 1) != 0) {
      plan->members[kept++] = plan->members[index];
    }
  }
  plan->count = kept;
  return NARSIL_OK;
}

void segment_runs_release(segment_run_plan *plan) {
  free(plan->members);
  free(plan->changes);
  free(plan->slots);
  segment_pool_release(&plan->pool);
  memset(plan, 0, sizeof *plan);
}

size_t segment_runs_bytes(const segment_run_plan *plan) {
  return (plan->capacity * (sizeof *plan->members + sizeof *plan->changes)) +
         (plan->slot_capacity * sizeof *plan->slots) + segment_pool_bytes(&plan->pool);
}
