#include "frozen.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_frozen_segments.h"

#include <stddef.h>
#include <stdint.h>

static size_t slot_of_row(const narsil_frozen_segment *segment, uint32_t row) {
  size_t low = 0;
  size_t high = segment->terms.count;
  while (low < high) {
    size_t middle = low + ((high - low) / 2);
    if (segment->posting_offsets[middle + 1] <= row) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

static narsil_status remove_indexed(frozen_removal_plan *plan, const narsil_remove_frozen_request *request) {
  const narsil_frozen_segment *segment = request->segment;
  const narsil_frozen_removal_index *index = segment->removal_index;
  uint32_t start = index->starts[request->ordinal];
  uint32_t end = index->starts[(size_t)request->ordinal + 1];
  if (start > end || end > segment->posting_count) { return NARSIL_OK; }
  uint32_t previous = 0;
  int held = 0;
  for (size_t at = start; at < end; at++) {
    uint32_t row = index->rows[at];
    if (row >= segment->posting_count || (held && row <= previous)) { continue; }
    previous = row;
    held = 1;
    if (segment->posting_documents[row] != request->ordinal || segment->posting_fields[row] >= segment->field_count) {
      continue;
    }
    size_t slot = slot_of_row(segment, row);
    if (slot >= segment->terms.count || segment->posting_offsets[slot] > row ||
        segment->posting_offsets[slot + 1] > segment->posting_count) {
      continue;
    }
    uint32_t term = index->term_of_slot[slot];
    if (term >= segment->terms.count || segment->payload_slots[term] != slot) { continue; }
    narsil_status status = frozen_removal_add(plan, FROZEN_TERM, term, segment->posting_frequencies[row]);
    if (status != NARSIL_OK) { return status; }
  }
  return NARSIL_OK;
}

narsil_status frozen_remove_counts(frozen_removal_plan *plan, const narsil_remove_frozen_request *request) {
  const narsil_frozen_segment *segment = request->segment;
  if (segment->removal_terms != NULL) {
    for (size_t at = 0; at < segment->removal_words; at += 2) {
      narsil_status status =
          frozen_removal_add(plan, FROZEN_TERM, segment->removal_terms[at], segment->removal_terms[at + 1]);
      if (status != NARSIL_OK) { return status; }
    }
    return NARSIL_OK;
  }
  if (segment->removal_index != NULL) { return remove_indexed(plan, request); }
  for (size_t term = 0; term < segment->terms.count; term++) {
    uint32_t slot = segment->payload_slots[term];
    if (slot >= segment->terms.count) { continue; }
    uint32_t start = segment->posting_offsets[slot];
    uint32_t end = segment->posting_offsets[(size_t)slot + 1];
    if (start > end || end > segment->posting_count) { continue; }
    double amount = 0;
    int found = 0;
    for (size_t row = start; row < end; row++) {
      if (segment->posting_documents[row] == request->ordinal && segment->posting_fields[row] < segment->field_count) {
        amount += segment->posting_frequencies[row];
        found = 1;
      }
    }
    if (found) {
      narsil_status status = frozen_removal_add(plan, FROZEN_TERM, (uint32_t)term, amount);
      if (status != NARSIL_OK) { return status; }
    }
  }
  return NARSIL_OK;
}
