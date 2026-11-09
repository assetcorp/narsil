#include "../../include/narsil_core.h"
#include "../../include/narsil_frozen_segments.h"
#include "frozen.h"
#include "scratch.h"

#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

static int order_changes(const frozen_change *first, const frozen_change *second) {
  if (first->kind != second->kind) { return first->kind < second->kind ? -1 : 1; }
  if (first->entry != second->entry) { return first->entry < second->entry ? -1 : 1; }
  return 0;
}

static int compare_changes(const void *left, const void *right) { return order_changes(left, right); }

static int valid_changes(const frozen_removal_plan *plan, const narsil_frozen_segment_state *state) {
  for (size_t at = 0; at < plan->count; at++) {
    const frozen_change *change = plan->changes + at;
    if (change->kind == FROZEN_TERM &&
        (!isfinite(state->removed_occurrences[change->entry]) || state->removed_occurrences[change->entry] < 0)) {
      return 0;
    }
  }
  return 1;
}

typedef struct {
  uint32_t removed;
  uint32_t stored;
} frozen_count;

static uint32_t clamped(frozen_count count, double amount) {
  double next = (double)count.removed + amount;
  return next >= count.stored ? count.stored : (uint32_t)next;
}

static void publish(const frozen_removal_plan *plan, const narsil_frozen_segment *segment,
                    narsil_frozen_segment_state *state) {
  for (size_t at = 0; at < plan->count;) {
    frozen_change change = plan->changes[at++];
    double documents = change.documents;
    while (at < plan->count && order_changes(plan->changes + at, &change) == 0) {
      documents += plan->changes[at].documents;
      change.amount += plan->changes[at++].amount;
    }
    uint32_t entry = change.entry;
    if (change.kind == FROZEN_TERM) {
      state->removed_documents[entry] =
          clamped((frozen_count){state->removed_documents[entry], segment->terms.counts[entry]}, documents);
      state->removed_occurrences[entry] += change.amount;
    } else if (change.kind == FROZEN_SURFACE) {
      state->removed_surfaces[entry] =
          clamped((frozen_count){state->removed_surfaces[entry], segment->surfaces->counts[entry]}, change.amount);
    } else {
      state->removed_spellings[entry] =
          clamped((frozen_count){state->removed_spellings[entry], segment->spellings->counts[entry]}, change.amount);
    }
  }
  state->pending_header[NARSIL_PENDING_DOCUMENTS] = 0;
  state->pending_header[NARSIL_PENDING_TOKENS] = 0;
  state->pending_header[NARSIL_PENDING_UNITS] = 0;
}

narsil_status frozen_settle(narsil_workspace *workspace, const narsil_frozen_segment *segment,
                            narsil_frozen_segment_state *state, const narsil_frozen_paged_removals *paged) {
  const uint32_t *header = state->pending_header;
  if (header[NARSIL_PENDING_DOCUMENTS] == 0 && header[NARSIL_PENDING_TOKENS] == 0 &&
      header[NARSIL_PENDING_UNITS] == 0) {
    return NARSIL_OK;
  }
  frozen_removal_plan *plan = &workspace_segment_scratch(workspace)->frozen;
  plan->count = 0;
  narsil_status status = frozen_settle_counts(workspace, plan, segment, state, paged);
  if (status == NARSIL_OK) { status = frozen_settle_strings(plan, segment, state); }
  if (status != NARSIL_OK) { return status; }
  if (!valid_changes(plan, state)) { return NARSIL_INVALID_ARGUMENT; }
  if (plan->count > 1) { qsort(plan->changes, plan->count, sizeof *plan->changes, compare_changes); }
  publish(plan, segment, state);
  return NARSIL_OK;
}
