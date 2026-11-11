#include "internal.h"

#include "../../include/narsil_core.h"
#include "../work/constants.h"
#include "../work/tally.h"
#include "constants.h"
#include "runs.h"

#include <stddef.h>
#include <stdint.h>

static void match_ordinal(uint32_t ordinal, const pattern_request *request, pattern_scratch *scratch,
                          work_tally *tally) {
  if (pattern_match_document(ordinal, request, scratch, tally)) { pattern_mark(request->into, ordinal); }
}

static narsil_status match_list(pattern_list list, const pattern_request *request, pattern_scratch *scratch,
                                work_tally *tally, int scanning) {
  uint32_t checked = 0;
  for (size_t at = 0; at < list.count; at++) {
    if (++checked == NARSIL_WORK_FLUSH_UNITS) {
      if (work_tally_flush(tally) != NARSIL_OK) { return tally->status; }
      checked = 0;
    }
    uint32_t ordinal = list.values[at];
    if (ordinal >= request->values->shape_count || pattern_marked(request->into, ordinal)) { continue; }
    if (scanning != 0 && work_tally_add(tally, 1) != NARSIL_OK) { return tally->status; }
    match_ordinal(ordinal, request, scratch, tally);
    if (tally->status != NARSIL_OK) { return tally->status; }
  }
  return NARSIL_OK;
}

static narsil_status match_typo_list(pattern_list list, const pattern_request *request, pattern_scratch *scratch,
                                     work_tally *tally) {
  if (work_tally_add(tally, list.count) != NARSIL_OK) { return tally->status; }
  uint32_t checked = 0;
  for (size_t at = 0; at < list.count; at++) {
    if (++checked == NARSIL_WORK_FLUSH_UNITS) {
      if (work_tally_flush(tally) != NARSIL_OK) { return tally->status; }
      checked = 0;
    }
    uint32_t ordinal = list.values[at];
    if (ordinal >= request->values->shape_count || pattern_marked(scratch->selected.values, ordinal)) { continue; }
    pattern_mark(scratch->selected.values, ordinal);
    if (pattern_marked(request->into, ordinal)) { continue; }
    match_ordinal(ordinal, request, scratch, tally);
    if (tally->status != NARSIL_OK) { return tally->status; }
  }
  return NARSIL_OK;
}

static narsil_status match_typo(const pattern_request *request, pattern_scratch *scratch, work_tally *tally) {
  uint32_t count = 1;
  if (scratch->typo.runs.count >= scratch->typo.needed) {
    count = scratch->typo.needed;
    for (uint32_t at = 0; at < scratch->typo.runs.count; at++) {
      if (work_tally_add(tally, 1) != NARSIL_OK) { return tally->status; }
    }
  }
  for (uint32_t at = 0; at < count; at++) {
    narsil_status status = match_typo_list(scratch->lists[at], request, scratch, tally);
    if (status != NARSIL_OK) { return status; }
  }
  return NARSIL_OK;
}

static narsil_status match_selected(const pattern_request *request, pattern_scratch *scratch, work_tally *tally) {
  uint32_t checked = 0;
  for (size_t word = 0; word < scratch->selected.length; word++) {
    if (++checked == NARSIL_WORK_FLUSH_UNITS) {
      if (work_tally_flush(tally) != NARSIL_OK) { return tally->status; }
      checked = 0;
    }
    uint32_t pending = scratch->selected.values[word] & ~request->into[word];
    while (pending != 0) {
      uint32_t bit = (uint32_t)__builtin_ctz(pending);
      pending &= pending - 1;
      uint32_t ordinal = (uint32_t)((word * PATTERN_WORD_BITS) + bit);
      match_ordinal(ordinal, request, scratch, tally);
      if (tally->status != NARSIL_OK) { return tally->status; }
    }
  }
  return NARSIL_OK;
}

narsil_status pattern_evaluate(pattern_scratch *scratch, const pattern_request *request, work_tally *tally) {
  if (scratch->matcher == PATTERN_TYPO_MATCHER) { return match_typo(request, scratch, tally); }
  if (scratch->branch_count == 0) { return match_list(request->index->documents, request, scratch, tally, 1); }
  for (size_t branch = 0; branch < scratch->branch_count; branch++) {
    const pattern_list *lists = scratch->lists + (branch * PATTERN_SHORTLIST_RUNS);
    narsil_status status = pattern_shortlist(lists, scratch->branches[branch].count, &scratch->candidates, tally);
    if (status != NARSIL_OK) { return status; }
    if (scratch->branch_count == 1) {
      pattern_list candidates = {scratch->candidates.values, scratch->candidates.length};
      return match_list(candidates, request, scratch, tally, 0);
    }
    uint32_t checked = 0;
    for (size_t at = 0; at < scratch->candidates.length; at++) {
      if (++checked == NARSIL_WORK_FLUSH_UNITS) {
        if (work_tally_flush(tally) != NARSIL_OK) { return tally->status; }
        checked = 0;
      }
      uint32_t ordinal = scratch->candidates.values[at];
      if (ordinal < request->values->shape_count) { pattern_mark(scratch->selected.values, ordinal); }
    }
  }
  return match_selected(request, scratch, tally);
}
