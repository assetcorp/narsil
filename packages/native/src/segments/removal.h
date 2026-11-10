#ifndef NARSIL_SEGMENT_REMOVAL_H
#define NARSIL_SEGMENT_REMOVAL_H

#include "../../include/narsil_segments.h"
#include "strings.h"

#include <stddef.h>
#include <stdint.h>

typedef struct {
  uint32_t ordinal;
  uint32_t kept;
  uint32_t last;
  uint8_t slice_class;
  double removed_frequency;
  int found;
  int compact;
  int ordered;
} segment_removal_change;

typedef struct {
  segment_removal_change *changes;
  size_t capacity;
  size_t count;
  uint32_t freed_positions;
} segment_removal_plan;

narsil_status segment_removal_prepare(segment_removal_plan *plan, const narsil_index_terms_request *request,
                                      const segment_strings *terms);
void segment_removal_publish(const segment_removal_plan *plan, const narsil_index_terms_request *request,
                             const segment_strings *terms);
void segment_removal_release(segment_removal_plan *plan);
size_t segment_removal_bytes(const segment_removal_plan *plan);

#endif
