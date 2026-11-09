#ifndef NARSIL_FROZEN_SEGMENT_INTERNAL_H
#define NARSIL_FROZEN_SEGMENT_INTERNAL_H

#include "../../include/narsil_core.h"
#include "../../include/narsil_frozen_segments.h"
#include "../analysis/text.h"
#include "regions.h"
#include "strings.h"

#include <stddef.h>
#include <stdint.h>

enum { FROZEN_TERM, FROZEN_SURFACE, FROZEN_SPELLING };

typedef struct {
  uint32_t kind;
  uint32_t entry;
  double amount;
} frozen_change;

enum { FROZEN_TABLE_ORDER_SLOTS = 16 };

typedef struct {
  const uint8_t *text;
  const uint32_t *offsets;
  size_t text_bytes;
  size_t count;
  int ascends;
} frozen_table_order;

typedef struct {
  frozen_change *changes;
  size_t count;
  size_t capacity;
  segment_strings surfaces;
  narsil_text text;
  frozen_table_order orders[FROZEN_TABLE_ORDER_SLOTS];
  size_t next_order;
} frozen_removal_plan;

narsil_status frozen_removal_regions(const narsil_remove_frozen_request *request);
int frozen_read_regions(const narsil_frozen_segment *segment, const narsil_frozen_segment_state *state,
                        const segment_regions *outputs);
narsil_status frozen_removal_output_regions(const narsil_remove_frozen_request *request,
                                            const narsil_frozen_removal_output *output, size_t *count);
narsil_status frozen_removal_add(frozen_removal_plan *plan, uint32_t kind, uint32_t entry, double amount);
void frozen_removal_release(frozen_removal_plan *plan);
size_t frozen_removal_bytes(const frozen_removal_plan *plan);
narsil_status frozen_remove_counts(frozen_removal_plan *plan, const narsil_remove_frozen_request *request);
narsil_status frozen_remove_strings(frozen_removal_plan *plan, const narsil_remove_frozen_request *request);

#endif
