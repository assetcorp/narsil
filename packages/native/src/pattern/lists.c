#include "internal.h"

#include "../../include/narsil_core.h"
#include "../allocation.h"
#include "../analysis/text.h"
#include "constants.h"
#include "runs.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

static narsil_status reserve_lists(pattern_scratch *scratch, size_t branches) {
  if (branches > SIZE_MAX / PATTERN_SHORTLIST_RUNS / sizeof *scratch->lists) { return NARSIL_OUT_OF_MEMORY; }
  size_t count = branches * PATTERN_SHORTLIST_RUNS;
  if (count > scratch->list_capacity) {
    pattern_list *lists = core_reallocate(scratch->lists, count * sizeof *lists);
    if (lists == NULL) { return NARSIL_OUT_OF_MEMORY; }
    scratch->lists = lists;
    scratch->list_capacity = count;
  }
  scratch->list_count = count;
  if (count > 0) { memset(scratch->lists, 0, count * sizeof *scratch->lists); }
  return NARSIL_OK;
}

narsil_status pattern_prepare_lists(pattern_scratch *scratch, const pattern_request *request) {
  int typo = scratch->matcher == PATTERN_TYPO_MATCHER;
  narsil_status status = reserve_lists(scratch, typo != 0 ? 1 : scratch->branch_count);
  if (status != NARSIL_OK) { return status; }
  size_t candidates = 0;
  if (typo != 0) {
    if (scratch->typo.runs.count < scratch->typo.needed) {
      scratch->lists[0] = request->index->documents;
    } else {
      pattern_run_lists(request->index, &scratch->typo.runs, scratch->lists);
    }
  } else {
    for (size_t at = 0; at < scratch->branch_count; at++) {
      pattern_list *lists = scratch->lists + (at * PATTERN_SHORTLIST_RUNS);
      pattern_run_lists(request->index, scratch->branches + at, lists);
      if (lists[0].count > candidates) { candidates = lists[0].count; }
    }
  }
  int allocated = narsil_code_points_reserve(&scratch->candidates, candidates);
  if (allocated != NARSIL_OK) { return (narsil_status)allocated; }
  scratch->selected.length = 0;
  if (typo != 0 || scratch->branch_count > 1) {
    size_t ordinals = request->values->shape_count;
    size_t words = ordinals == 0 ? 1 : ((ordinals - 1) / PATTERN_WORD_BITS) + 1;
    allocated = narsil_code_points_reserve(&scratch->selected, words);
    if (allocated != NARSIL_OK) { return (narsil_status)allocated; }
    memset(scratch->selected.values, 0, words * sizeof *scratch->selected.values);
    scratch->selected.length = words;
  }
  return NARSIL_OK;
}
