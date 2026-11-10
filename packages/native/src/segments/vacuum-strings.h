#ifndef NARSIL_SEGMENT_VACUUM_STRINGS_H
#define NARSIL_SEGMENT_VACUUM_STRINGS_H

#include "../../include/narsil_segments.h"

#include <stddef.h>
#include <stdint.h>

typedef struct {
  uint32_t offset;
  uint32_t length;
  uint32_t token;
  uint32_t count;
  uint32_t points;
} segment_vacuum_string;

typedef struct {
  segment_vacuum_string *entries;
  size_t entry_capacity;
  uint32_t *mapping;
  size_t mapping_capacity;
  uint16_t *units;
  size_t unit_capacity;
  size_t source_count;
  size_t count;
  size_t unit_count;
} segment_string_vacuum;

narsil_status segment_string_vacuum_prepare(segment_string_vacuum *plan, const narsil_surface_table *table,
                                            const uint32_t *points, const uint32_t *tokens, size_t token_count);
void segment_string_vacuum_publish(const segment_string_vacuum *plan, narsil_surface_table *table, uint32_t *points);
void segment_string_vacuum_release(segment_string_vacuum *plan);
size_t segment_string_vacuum_bytes(const segment_string_vacuum *plan);

#endif
