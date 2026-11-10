#include "internal.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_stored_values.h"
#include "../stored_values/values.h"
#include "../work/constants.h"
#include "../work/tally.h"
#include "cache.h"
#include "literal.h"
#include "simulation.h"
#include "text.h"
#include "typo.h"

#include <stddef.h>
#include <stdint.h>

static int expression_match(pattern_scratch *scratch, pattern_text_cursor *value, work_tally *tally) {
  pattern_dfa_begin(&scratch->cache, &scratch->simulation);
  uint32_t point = 0;
  uint32_t checked = 0;
  while (pattern_text_next(value, &point)) {
    uint32_t outcome = pattern_dfa_step(&scratch->program, &scratch->cache, &scratch->simulation, point);
    if (work_tally_add(tally, scratch->simulation.steps) != NARSIL_OK) { return 0; }
    if (outcome != PATTERN_STEP_CONTINUES) { return outcome == PATTERN_STEP_MATCHED; }
    if (++checked == NARSIL_WORK_FLUSH_UNITS) {
      if (work_tally_flush(tally) != NARSIL_OK) { return 0; }
      checked = 0;
    }
  }
  return pattern_dfa_end(&scratch->program, &scratch->cache, &scratch->simulation);
}

static int match_value(pattern_scratch *scratch, pattern_text_cursor *value, work_tally *tally) {
  if (scratch->matcher == PATTERN_LITERAL_MATCHER) { return pattern_literal_match(&scratch->literal, value, tally); }
  if (scratch->matcher == PATTERN_TYPO_MATCHER) { return pattern_typo_match(&scratch->typo, value, tally); }
  return expression_match(scratch, value, tally);
}

int pattern_match_document(uint32_t ordinal, const pattern_request *request, pattern_scratch *scratch,
                           work_tally *tally) {
  const narsil_stored_values *values = request->values;
  if (ordinal >= values->shape_count) { return 0; }
  uint8_t shape = values->shapes[ordinal];
  uint32_t start = values->starts[ordinal];
  uint32_t end = values->starts[(size_t)ordinal + 1];
  if (shape == STORED_ABSENT || shape > STORED_ARRAY || start > end || end > values->kind_count ||
      (shape == STORED_SCALAR && end - start != 1)) {
    return 0;
  }
  uint32_t checked = 0;
  for (uint32_t at = start; at < end; at++) {
    if (++checked == NARSIL_WORK_FLUSH_UNITS) {
      if (work_tally_flush(tally) != NARSIL_OK) { return 0; }
      checked = 0;
    }
    if (values->kinds[at] != STORED_STRING || !stored_element_valid(values, at)) { continue; }
    pattern_text_cursor value = {0};
    value.length = values->text_length[at];
    value.units = value.length == 0 ? NULL : values->units + values->text_start[at];
    value.case_fold = request->test->case_fold;
    if (match_value(scratch, &value, tally)) { return 1; }
    if (tally->status != NARSIL_OK) { return 0; }
  }
  return 0;
}
