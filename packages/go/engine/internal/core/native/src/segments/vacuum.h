#ifndef NARSIL_SEGMENT_VACUUM_H
#define NARSIL_SEGMENT_VACUUM_H

#include "../../include/narsil_core.h"
#include "../../include/narsil_segments.h"
#include "pools.h"
#include "vacuum-runs.h"
#include "vacuum-strings.h"

#include <stddef.h>
#include <stdint.h>

typedef struct {
  uint32_t text_start;
  uint32_t text_length;
  uint32_t row_start;
  uint32_t length;
  uint32_t frequency;
  uint32_t revision;
  double occurrences;
  double surfaces;
  uint8_t slice_class;
  uint8_t flags;
} segment_vacuum_term;

typedef struct {
  uint32_t document;
  uint32_t positions;
  uint16_t frequency;
  uint16_t field;
} segment_vacuum_row;

typedef struct {
  uint32_t *mapping;
  size_t mapping_capacity;
  segment_vacuum_term *terms;
  size_t term_capacity;
  uint8_t *marks;
  size_t mark_capacity;
  segment_vacuum_row *rows;
  size_t row_capacity;
  uint16_t *units;
  size_t unit_capacity;
  uint32_t *positions;
  size_t position_capacity;
  size_t source_count;
  size_t term_count;
  size_t row_count;
  size_t unit_count;
  size_t position_count;
  size_t freed_positions;
  segment_string_vacuum surfaces;
  segment_string_vacuum spellings;
  segment_run_vacuum runs;
  int active;
  int repacking;
  int rebuilds_positions;
} segment_vacuum;

narsil_status segment_vacuum_prepare(segment_vacuum *plan, const narsil_growing_segment *segment);
void segment_vacuum_publish(const segment_vacuum *plan, narsil_growing_segment *segment);
narsil_status segment_vacuum_validate(segment_vacuum *plan, const narsil_growing_segment *segment);
int segment_vacuum_holds_no_slice(const narsil_growing_segment *segment, uint32_t ordinal);
narsil_status segment_repack_prepare(segment_vacuum *plan, const narsil_growing_segment *segment);
void segment_repack_publish(const segment_vacuum *plan, narsil_growing_segment *segment);
void segment_vacuum_release(segment_vacuum *plan);
size_t segment_vacuum_bytes(const segment_vacuum *plan);

#endif
