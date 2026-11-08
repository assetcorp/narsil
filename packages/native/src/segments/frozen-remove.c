#include "../../include/narsil_frozen_segments.h"

#include "../../include/narsil_core.h"
#include "frozen.h"
#include "scratch.h"

#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

enum { FROZEN_WORD_BITS = 32 };

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

static void publish(const frozen_removal_plan *plan, const narsil_remove_frozen_request *request) {
  const narsil_frozen_segment *segment = request->segment;
  narsil_frozen_segment_state *state = request->state;
  for (size_t at = 0; at < plan->count;) {
    frozen_change change = plan->changes[at++];
    while (at < plan->count && plan->changes[at].kind == change.kind && plan->changes[at].entry == change.entry) {
      change.amount += plan->changes[at++].amount;
    }
    uint32_t entry = change.entry;
    if (change.kind == FROZEN_TERM) {
      if (state->removed_documents[entry] < segment->terms.counts[entry]) { state->removed_documents[entry]++; }
      state->removed_occurrences[entry] += change.amount;
    } else {
      uint32_t *removed = change.kind == FROZEN_SURFACE ? state->removed_surfaces : state->removed_spellings;
      const uint32_t *counts = change.kind == FROZEN_SURFACE ? segment->surfaces->counts : segment->spellings->counts;
      double next = removed[entry] + change.amount;
      removed[entry] = next >= counts[entry] ? counts[entry] : (uint32_t)next;
    }
  }
  state->tombstones[request->ordinal / FROZEN_WORD_BITS] |= UINT32_C(1) << (request->ordinal % FROZEN_WORD_BITS);
  (*state->tombstone_count)++;
}

static narsil_status prepare(narsil_workspace *workspace, const narsil_remove_frozen_request *request,
                             frozen_removal_plan **prepared) {
  if (workspace == NULL) { return NARSIL_INVALID_ARGUMENT; }
  const narsil_frozen_segment_state *state = request->state;
  if ((state->tombstones[request->ordinal / FROZEN_WORD_BITS] &
       (UINT32_C(1) << (request->ordinal % FROZEN_WORD_BITS))) != 0) {
    return NARSIL_OK;
  }
  if (*state->tombstone_count == request->segment->document_count) { return NARSIL_INVALID_ARGUMENT; }
  frozen_removal_plan *plan = &workspace_segment_scratch(workspace)->frozen;
  plan->count = 0;
  narsil_status status = frozen_remove_counts(plan, request);
  if (status == NARSIL_OK) { status = frozen_remove_strings(plan, request); }
  if (status != NARSIL_OK) { return status; }
  if (!valid_changes(plan, state)) { return NARSIL_INVALID_ARGUMENT; }
  if (plan->count > 1) { qsort(plan->changes, plan->count, sizeof *plan->changes, compare_changes); }
  *prepared = plan;
  return NARSIL_OK;
}

narsil_status narsil_remove_frozen_document(narsil_workspace *workspace, const narsil_remove_frozen_request *request) {
  narsil_status status = frozen_removal_regions(request);
  if (status != NARSIL_OK) { return status; }
  frozen_removal_plan *plan = NULL;
  status = prepare(workspace, request, &plan);
  if (status == NARSIL_OK && plan != NULL) { publish(plan, request); }
  return status;
}

static size_t output_count(const frozen_removal_plan *plan) {
  size_t count = 2;
  for (size_t at = 0; at < plan->count; at++) {
    if (at > 0 && order_changes(plan->changes + at - 1, plan->changes + at) == 0) { continue; }
    size_t words = plan->changes[at].kind == FROZEN_TERM ? 2 : 1;
    if (count > SIZE_MAX - words) { return SIZE_MAX; }
    count += words;
  }
  return count;
}

enum { REMOVED_DOCUMENTS, REMOVED_OCCURRENCES, REMOVED_SURFACES, REMOVED_SPELLINGS, TOMBSTONES, TOMBSTONE_COUNT };

typedef struct {
  uint32_t kind;
  uint32_t entry;
  double value;
} frozen_replacement;

static void update(const narsil_frozen_removal_output *output, size_t position, frozen_replacement replacement) {
  output->entries[position * 2] = replacement.kind;
  output->entries[(position * 2) + 1] = replacement.entry;
  output->values[position] = replacement.value;
}

static void write_output(const frozen_removal_plan *plan, const narsil_remove_frozen_request *request,
                         const narsil_frozen_removal_output *output) {
  const narsil_frozen_segment *segment = request->segment;
  const narsil_frozen_segment_state *state = request->state;
  size_t written = 0;
  for (size_t at = 0; at < plan->count;) {
    frozen_change change = plan->changes[at++];
    while (at < plan->count && plan->changes[at].kind == change.kind && plan->changes[at].entry == change.entry) {
      change.amount += plan->changes[at++].amount;
    }
    uint32_t entry = change.entry;
    if (change.kind == FROZEN_TERM) {
      uint32_t documents = state->removed_documents[entry];
      if (documents < segment->terms.counts[entry]) { documents++; }
      update(output, written++, (frozen_replacement){REMOVED_DOCUMENTS, entry, documents});
      update(output, written++,
             (frozen_replacement){REMOVED_OCCURRENCES, entry, state->removed_occurrences[entry] + change.amount});
    } else {
      int surface = change.kind == FROZEN_SURFACE;
      const uint32_t *removed = surface ? state->removed_surfaces : state->removed_spellings;
      const uint32_t *counts = surface ? segment->surfaces->counts : segment->spellings->counts;
      double next = removed[entry] + change.amount;
      update(output, written++,
             (frozen_replacement){surface ? REMOVED_SURFACES : REMOVED_SPELLINGS, entry,
                                  next >= counts[entry] ? counts[entry] : next});
    }
  }
  uint32_t word = request->ordinal / FROZEN_WORD_BITS;
  uint32_t bits = state->tombstones[word] | (UINT32_C(1) << (request->ordinal % FROZEN_WORD_BITS));
  update(output, written++, (frozen_replacement){TOMBSTONES, word, bits});
  update(output, written, (frozen_replacement){TOMBSTONE_COUNT, 0, *state->tombstone_count + 1});
}

narsil_status narsil_prepare_frozen_removal(narsil_workspace *workspace, const narsil_remove_frozen_request *request,
                                            const narsil_frozen_removal_output *output, size_t *count) {
  narsil_status status = frozen_removal_regions(request);
  if (status != NARSIL_OK) { return status; }
  status = frozen_removal_output_regions(request, output, count);
  if (status != NARSIL_OK) { return status; }
  frozen_removal_plan *plan = NULL;
  status = prepare(workspace, request, &plan);
  if (status != NARSIL_OK) { return status; }
  size_t needed = plan == NULL ? 0 : output_count(plan);
  if (needed > output->entry_capacity || needed > output->value_capacity) { return NARSIL_NEEDS_ROOM; }
  if (plan != NULL) { write_output(plan, request, output); }
  *count = needed;
  return NARSIL_OK;
}
