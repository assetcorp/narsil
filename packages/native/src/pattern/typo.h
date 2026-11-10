#ifndef NARSIL_PATTERN_TYPO_H
#define NARSIL_PATTERN_TYPO_H

#include "../../include/narsil_core.h"
#include "../analysis/text.h"
#include "../work/tally.h"
#include "runs.h"
#include "text.h"

#include <stddef.h>
#include <stdint.h>

typedef struct {
  narsil_code_points raw;
  narsil_code_points folded;
  narsil_code_points value;
  uint32_t *rows;
  size_t row_capacity;
  pattern_runs runs;
  uint32_t longest_fold;
  uint32_t tolerance;
  uint32_t needed;
  uint32_t case_fold;
} pattern_typo;

typedef struct {
  const uint16_t *text;
  size_t length;
  uint32_t tolerance;
  uint32_t case_fold;
  uint32_t count_preparation;
} pattern_typo_request;

narsil_status pattern_typo_prepare(pattern_typo *typo, const pattern_typo_request *request, work_tally *tally);
narsil_status pattern_typo_reserve(pattern_typo *typo);
int pattern_typo_match(pattern_typo *typo, pattern_text_cursor *value, work_tally *tally);

#endif
