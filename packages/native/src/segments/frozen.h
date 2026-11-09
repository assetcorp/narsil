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
  uint32_t documents;
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
  uint32_t *words;
  size_t word_capacity;
  uint32_t *marks;
  size_t mark_capacity;
} frozen_removal_plan;

typedef struct {
  uint64_t documents;
  uint64_t tokens;
  uint64_t units;
} frozen_pending_size;

narsil_status frozen_removal_regions(const narsil_remove_frozen_request *request);
int frozen_read_regions(const narsil_frozen_segment *segment, const narsil_frozen_segment_state *state,
                        const segment_regions *outputs);
narsil_status frozen_removal_output_regions(const narsil_remove_frozen_request *request,
                                            const narsil_frozen_removal_output *output, size_t *count);
narsil_status frozen_settle_regions(const narsil_frozen_segment *segment, const narsil_frozen_segment_state *state);
narsil_status frozen_removal_add(frozen_removal_plan *plan, uint32_t kind, uint32_t entry, uint32_t documents,
                                 double amount);
narsil_status frozen_reserve_words(uint32_t **words, size_t *capacity, size_t count);
void frozen_removal_release(frozen_removal_plan *plan);
size_t frozen_removal_bytes(const frozen_removal_plan *plan);
narsil_status frozen_settle_counts(narsil_workspace *workspace, frozen_removal_plan *plan,
                                   const narsil_frozen_segment *segment, const narsil_frozen_segment_state *state,
                                   const narsil_frozen_paged_removals *paged);
narsil_status frozen_settle_strings(frozen_removal_plan *plan, const narsil_frozen_segment *segment,
                                    const narsil_frozen_segment_state *state);
frozen_pending_size frozen_pending_needed(const narsil_remove_frozen_request *request);
void frozen_pending_append(const narsil_remove_frozen_request *request);
narsil_status frozen_settle(narsil_workspace *workspace, const narsil_frozen_segment *segment,
                            narsil_frozen_segment_state *state, const narsil_frozen_paged_removals *paged);

#endif
