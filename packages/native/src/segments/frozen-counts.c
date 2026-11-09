#include "frozen.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_frozen_segments.h"
#include "../../include/narsil_paged.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

enum { FROZEN_WORD_BITS = 32, FROZEN_PAIR_WORDS = 2, FROZEN_FIRST_STAMP = 2 };

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

static narsil_status add_term(frozen_removal_plan *plan, size_t first, uint32_t term, double amount) {
  if (plan->count > first) {
    frozen_change *last = plan->changes + plan->count - 1;
    if (last->kind == FROZEN_TERM && last->entry == term) {
      last->amount += amount;
      return NARSIL_OK;
    }
  }
  return frozen_removal_add(plan, FROZEN_TERM, term, 1, amount);
}

static narsil_status remove_indexed(frozen_removal_plan *plan, const narsil_frozen_segment *segment, uint32_t ordinal) {
  const narsil_frozen_removal_index *index = segment->removal_index;
  uint32_t start = index->starts[ordinal];
  uint32_t end = index->starts[(size_t)ordinal + 1];
  if (start > end || end > segment->posting_count) { return NARSIL_OK; }
  size_t first = plan->count;
  uint32_t previous = 0;
  int held = 0;
  for (size_t at = start; at < end; at++) {
    uint32_t row = index->rows[at];
    if (row >= segment->posting_count || (held && row <= previous)) { continue; }
    previous = row;
    held = 1;
    if (segment->posting_documents[row] != ordinal || segment->posting_fields[row] >= segment->field_count) {
      continue;
    }
    size_t slot = slot_of_row(segment, row);
    if (slot >= segment->terms.count || segment->posting_offsets[slot] > row ||
        segment->posting_offsets[slot + 1] > segment->posting_count) {
      continue;
    }
    uint32_t term = index->term_of_slot[slot];
    if (term >= segment->terms.count || segment->payload_slots[term] != slot) { continue; }
    narsil_status status = add_term(plan, first, term, segment->posting_frequencies[row]);
    if (status != NARSIL_OK) { return status; }
  }
  return NARSIL_OK;
}

static narsil_status remove_paged(narsil_workspace *workspace, frozen_removal_plan *plan,
                                  const narsil_frozen_segment *segment, const narsil_frozen_paged_removals *paged,
                                  uint32_t ordinal) {
  size_t limit = paged->values->length / sizeof(uint32_t);
  narsil_status status = frozen_reserve_words(&plan->words, &plan->word_capacity, 1);
  uint32_t words = 0;
  while (status == NARSIL_OK) {
    narsil_paged_removal_list list = {paged->offsets, paged->values, ordinal, (uint32_t)segment->terms.count};
    narsil_paged_removal_output output = {plan->words, plan->word_capacity, &words};
    status = narsil_read_paged_removals(workspace, paged->cache, list, output, paged->fault);
    if (status != NARSIL_NEEDS_ROOM) { break; }
    if (plan->word_capacity > limit) { return NARSIL_INVALID_ARGUMENT; }
    status = frozen_reserve_words(&plan->words, &plan->word_capacity, plan->word_capacity + 1);
  }
  if (status != NARSIL_OK) { return status; }
  for (uint32_t at = 0; at < words; at += FROZEN_PAIR_WORDS) {
    status = frozen_removal_add(plan, FROZEN_TERM, plan->words[at], 1, plan->words[at + 1]);
    if (status != NARSIL_OK) { return status; }
  }
  return NARSIL_OK;
}

static narsil_status scan_postings(frozen_removal_plan *plan, const narsil_frozen_segment *segment) {
  uint32_t *stamps = plan->marks;
  for (size_t term = 0; term < segment->terms.count; term++) {
    uint32_t slot = segment->payload_slots[term];
    if (slot >= segment->terms.count) { continue; }
    uint32_t start = segment->posting_offsets[slot];
    uint32_t end = segment->posting_offsets[(size_t)slot + 1];
    if (start > end || end > segment->posting_count) { continue; }
    uint32_t stamp = (uint32_t)term + FROZEN_FIRST_STAMP;
    uint32_t documents = 0;
    double amount = 0;
    for (size_t row = start; row < end; row++) {
      uint32_t ordinal = segment->posting_documents[row];
      if (ordinal >= segment->document_count || stamps[ordinal] == 0 ||
          segment->posting_fields[row] >= segment->field_count) {
        continue;
      }
      amount += segment->posting_frequencies[row];
      if (stamps[ordinal] != stamp) {
        stamps[ordinal] = stamp;
        documents++;
      }
    }
    if (documents > 0) {
      narsil_status status = frozen_removal_add(plan, FROZEN_TERM, (uint32_t)term, documents, amount);
      if (status != NARSIL_OK) { return status; }
    }
  }
  return NARSIL_OK;
}

static narsil_status mark_pending(frozen_removal_plan *plan, const narsil_frozen_segment *segment,
                                  const narsil_frozen_segment_state *state, int stamped, size_t *marked) {
  size_t words =
      stamped ? segment->document_count : (((size_t)segment->document_count + FROZEN_WORD_BITS - 1) / FROZEN_WORD_BITS);
  size_t cleared = plan->mark_capacity;
  narsil_status status = frozen_reserve_words(&plan->marks, &plan->mark_capacity, words == 0 ? 1 : words);
  if (status != NARSIL_OK) { return status; }
  if (plan->mark_capacity > cleared) {
    memset(plan->marks + cleared, 0, (plan->mark_capacity - cleared) * sizeof *plan->marks);
  }
  uint32_t pending = state->pending_header[NARSIL_PENDING_DOCUMENTS];
  for (uint32_t at = 0; at < pending; at++) {
    uint32_t ordinal = state->pending_documents[at];
    if (ordinal >= segment->document_count ||
        (state->tombstones[ordinal / FROZEN_WORD_BITS] & (UINT32_C(1) << (ordinal % FROZEN_WORD_BITS))) == 0) {
      return NARSIL_INVALID_ARGUMENT;
    }
    uint32_t *word = plan->marks + (stamped ? ordinal : ordinal / FROZEN_WORD_BITS);
    uint32_t bit = stamped ? 1 : UINT32_C(1) << (ordinal % FROZEN_WORD_BITS);
    if ((*word & bit) != 0) { return NARSIL_INVALID_ARGUMENT; }
    *word |= bit;
    *marked = at + 1;
  }
  return NARSIL_OK;
}

typedef struct {
  int stamped;
  size_t marked;
} frozen_marks;

static void clear_marks(frozen_removal_plan *plan, const narsil_frozen_segment_state *state, frozen_marks marks) {
  for (size_t at = 0; at < marks.marked; at++) {
    uint32_t ordinal = state->pending_documents[at];
    plan->marks[marks.stamped ? ordinal : ordinal / FROZEN_WORD_BITS] = 0;
  }
}

narsil_status frozen_settle_counts(narsil_workspace *workspace, frozen_removal_plan *plan,
                                   const narsil_frozen_segment *segment, const narsil_frozen_segment_state *state,
                                   const narsil_frozen_paged_removals *paged) {
  int stamped = paged == NULL && segment->removal_index == NULL;
  if (stamped && segment->terms.count > (size_t)UINT32_MAX - FROZEN_FIRST_STAMP) { return NARSIL_INVALID_ARGUMENT; }
  size_t marked = 0;
  narsil_status status = mark_pending(plan, segment, state, stamped, &marked);
  if (status == NARSIL_OK && stamped) { status = scan_postings(plan, segment); }
  uint32_t pending = state->pending_header[NARSIL_PENDING_DOCUMENTS];
  for (uint32_t at = 0; status == NARSIL_OK && !stamped && at < pending; at++) {
    uint32_t ordinal = state->pending_documents[at];
    status =
        paged != NULL ? remove_paged(workspace, plan, segment, paged, ordinal) : remove_indexed(plan, segment, ordinal);
  }
  clear_marks(plan, state, (frozen_marks){stamped, marked});
  return status;
}
