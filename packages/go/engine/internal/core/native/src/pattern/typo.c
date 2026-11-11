#include "typo.h"

#include "../../include/narsil_core.h"
#include "../analysis/text.h"
#include "../work/tally.h"
#include "constants.h"
#include "runs.h"
#include "text.h"

#include <stddef.h>
#include <stdint.h>

static narsil_status fold_query(pattern_typo *typo, const pattern_typo_request *request, work_tally *tally) {
  typo->raw.length = 0;
  typo->folded.length = 0;
  typo->longest_fold = 0;
  size_t position = 0;
  while (position < request->length) {
    if (request->count_preparation != 0 && work_tally_add(tally, 1) != NARSIL_OK) { return tally->status; }
    uint32_t point = narsil_decode_next(request->text, request->length, &position);
    int status = narsil_code_points_push(&typo->raw, point);
    if (status != NARSIL_OK) { return (narsil_status)status; }
    uint32_t folded[PATTERN_MAX_FOLD_LENGTH];
    uint32_t count = pattern_fold_point(point, folded);
    if (count > typo->longest_fold) { typo->longest_fold = count; }
    for (uint32_t i = 0; i < count; i++) {
      status = narsil_code_points_push(&typo->folded, folded[i]);
      if (status != NARSIL_OK) { return (narsil_status)status; }
    }
  }
  return NARSIL_OK;
}

static narsil_status keep_run(pattern_typo *typo, size_t position, work_tally *tally, uint32_t count_preparation) {
  if (count_preparation != 0 && work_tally_add(tally, 1) != NARSIL_OK) { return tally->status; }
  pattern_keep_run(&typo->runs, typo->folded.values + position);
  return NARSIL_OK;
}

static narsil_status distinct_runs(pattern_typo *typo, work_tally *tally, uint32_t count_preparation) {
  typo->runs.count = 0;
  size_t length = typo->folded.length;
  if (length < PATTERN_RUN_POINTS) { return NARSIL_OK; }
  size_t positions = length - PATTERN_RUN_POINTS + 1;
  if (positions > PATTERN_SHORTLIST_RUNS) {
    for (uint32_t pick = 0; pick < PATTERN_SHORTLIST_RUNS; pick++) {
      size_t position =
          (((size_t)pick * (positions - 1)) + ((PATTERN_SHORTLIST_RUNS - 1) / 2)) / (PATTERN_SHORTLIST_RUNS - 1);
      narsil_status status = keep_run(typo, position, tally, count_preparation);
      if (status != NARSIL_OK) { return status; }
    }
  }
  for (size_t position = 0; position < positions && typo->runs.count < PATTERN_SHORTLIST_RUNS; position++) {
    narsil_status status = keep_run(typo, position, tally, count_preparation);
    if (status != NARSIL_OK) { return status; }
  }
  return NARSIL_OK;
}

narsil_status pattern_typo_prepare(pattern_typo *typo, const pattern_typo_request *request, work_tally *tally) {
  narsil_status status = fold_query(typo, request, tally);
  if (status != NARSIL_OK) { return status; }
  status = distinct_runs(typo, tally, request->count_preparation);
  if (status != NARSIL_OK) { return status; }
  uint32_t tolerance = request->tolerance;
  if (tolerance == PATTERN_AUTO_TOLERANCE) {
    tolerance = PATTERN_MAX_TOLERANCE;
    while (tolerance > 0 && typo->runs.count < (tolerance * (2 + typo->longest_fold)) + 1) { tolerance--; }
  }
  typo->tolerance = tolerance;
  typo->case_fold = request->case_fold;
  typo->needed = (tolerance * (2 + typo->longest_fold)) + 1;
  if (tolerance > 0 && request->case_fold != 0 && request->count_preparation != 0) {
    return work_tally_add(tally, typo->folded.length);
  }
  return NARSIL_OK;
}
