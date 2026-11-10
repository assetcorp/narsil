#include "internal.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_pattern.h"
#include "../../include/narsil_work.h"
#include "../analysis/text.h"
#include "../work/tally.h"
#include "constants.h"
#include "literal.h"
#include "runs.h"
#include "text.h"
#include "typo.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

narsil_status pattern_reserve_branches(pattern_scratch *scratch, size_t count) {
  if (count <= scratch->branch_capacity) { return NARSIL_OK; }
  if (count > SIZE_MAX / sizeof *scratch->branches) { return NARSIL_OUT_OF_MEMORY; }
  pattern_runs *branches = realloc(scratch->branches, count * sizeof *branches);
  if (branches == NULL) { return NARSIL_OUT_OF_MEMORY; }
  scratch->branches = branches;
  scratch->branch_capacity = count;
  return NARSIL_OK;
}

static narsil_status prepare_literal(pattern_scratch *scratch, const narsil_pattern_test *test) {
  narsil_status status = pattern_text_points(&scratch->folded, test->text, test->length, 1);
  if (status != NARSIL_OK) { return status; }
  status = pattern_reserve_branches(scratch, 1);
  if (status != NARSIL_OK) { return status; }
  pattern_list factor = {scratch->folded.values, scratch->folded.length};
  pattern_spread_runs(scratch->branches, &factor, 1);
  scratch->branch_count = scratch->branches[0].count == 0 ? 0 : 1;
  const narsil_code_points *points = test->case_fold != 0 ? &scratch->folded : &scratch->raw;
  scratch->literal.anchored_start =
      test->operator_kind == NARSIL_PATTERN_EQ || test->operator_kind == NARSIL_PATTERN_STARTS_WITH;
  scratch->literal.anchored_end =
      test->operator_kind == NARSIL_PATTERN_EQ || test->operator_kind == NARSIL_PATTERN_ENDS_WITH;
  return pattern_literal_prepare(&scratch->literal, points->values, (uint32_t)points->length);
}

static narsil_status prepare_typo(pattern_scratch *scratch, const narsil_pattern_test *test) {
  int64_t spent = 0;
  uint32_t stop = 0;
  narsil_work_meter meter = {&spent, INT64_MAX, &stop, 0};
  work_tally tally;
  narsil_status status = work_tally_begin(&tally, &meter);
  if (status != NARSIL_OK) { return status; }
  pattern_typo_request request = {test->text, test->length, test->tolerance, test->case_fold, test->count_preparation};
  status = pattern_typo_prepare(&scratch->typo, &request, &tally);
  if (status != NARSIL_OK) { return status; }
  status = work_tally_flush(&tally);
  if (status != NARSIL_OK) { return status; }
  scratch->preparation_units = spent;
  if (scratch->typo.tolerance == 0) { return NARSIL_OK; }
  scratch->matcher = PATTERN_TYPO_MATCHER;
  return pattern_typo_reserve(&scratch->typo);
}

narsil_status pattern_prepare(pattern_scratch *scratch, const narsil_pattern_test *test) {
  scratch->matcher = PATTERN_LITERAL_MATCHER;
  scratch->branch_count = 0;
  scratch->preparation_units = 0;
  if (test->length > (size_t)PATTERN_MAX_TEXT_POINTS * 2) { return NARSIL_INVALID_ARGUMENT; }
  narsil_status status = pattern_text_points(&scratch->raw, test->text, test->length, 0);
  if (status != NARSIL_OK) { return status; }
  if (scratch->raw.length > PATTERN_MAX_TEXT_POINTS) { return NARSIL_INVALID_ARGUMENT; }
  if (test->operator_kind == NARSIL_PATTERN_REGEX || test->operator_kind == NARSIL_PATTERN_WILDCARD) {
    return pattern_prepare_expression(scratch, test);
  }
  if (test->operator_kind == NARSIL_PATTERN_EQ && test->tolerance != 0) {
    status = prepare_typo(scratch, test);
    if (status != NARSIL_OK || scratch->matcher == PATTERN_TYPO_MATCHER) { return status; }
  }
  return prepare_literal(scratch, test);
}
