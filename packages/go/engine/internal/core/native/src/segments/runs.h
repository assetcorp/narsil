#ifndef NARSIL_SEGMENT_RUNS_H
#define NARSIL_SEGMENT_RUNS_H

#include "../../include/narsil_core.h"
#include "../../include/narsil_segments.h"
#include "pools.h"
#include "strings.h"

#include <stddef.h>
#include <stdint.h>

enum { SEGMENT_RUN_POINTS = 3 };

typedef struct {
  uint32_t points[SEGMENT_RUN_POINTS];
  uint32_t spelling;
} segment_run_member;

typedef struct {
  size_t start;
  size_t length;
  uint32_t ordinal;
  uint32_t slot;
  uint32_t old_length;
  uint32_t added;
  segment_slice source;
  segment_slice target;
} segment_run_change;

typedef struct {
  segment_run_member *members;
  segment_run_change *changes;
  uint32_t *slots;
  size_t capacity;
  size_t slot_capacity;
  size_t count;
  size_t change_count;
  uint32_t added;
  segment_pool_plan pool;
} segment_run_plan;

narsil_status segment_runs_collect(segment_run_plan *plan, const segment_strings *spellings);
narsil_status segment_runs_prepare(segment_run_plan *plan, const narsil_run_table *table);
void segment_runs_publish(const segment_run_plan *plan, narsil_run_table *table);
narsil_status segment_runs_prepare_removal(segment_run_plan *plan, const narsil_run_table *table);
void segment_runs_remove(const segment_run_plan *plan, narsil_run_table *table);
void segment_runs_release(segment_run_plan *plan);
size_t segment_runs_bytes(const segment_run_plan *plan);
uint32_t segment_run_hash(const uint32_t points[SEGMENT_RUN_POINTS]);
int segment_run_equal(const uint32_t left[SEGMENT_RUN_POINTS], const uint32_t right[SEGMENT_RUN_POINTS]);

#endif
