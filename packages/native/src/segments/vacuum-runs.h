#ifndef NARSIL_SEGMENT_VACUUM_RUNS_H
#define NARSIL_SEGMENT_VACUUM_RUNS_H

#include "runs.h"
#include "vacuum-strings.h"

typedef struct {
  uint32_t points[SEGMENT_RUN_POINTS];
  uint32_t start;
  uint32_t length;
  uint8_t slice_class;
} segment_vacuum_run;

typedef struct {
  segment_vacuum_run *runs;
  size_t run_capacity;
  segment_slice *slices;
  size_t slice_capacity;
  uint32_t *members;
  size_t member_capacity;
  size_t count;
  size_t member_count;
  size_t source_count;
} segment_run_vacuum;

narsil_status segment_run_vacuum_prepare(segment_run_vacuum *plan, const narsil_run_table *table,
                                         const segment_string_vacuum *spellings);
void segment_run_vacuum_publish(const segment_run_vacuum *plan, narsil_run_table *table);
void segment_run_vacuum_release(segment_run_vacuum *plan);
size_t segment_run_vacuum_bytes(const segment_run_vacuum *plan);

#endif
