#ifndef NARSIL_PATTERN_TEXT_H
#define NARSIL_PATTERN_TEXT_H

#include "../../include/narsil_core.h"
#include "../analysis/text.h"
#include "constants.h"

#include <stddef.h>
#include <stdint.h>

typedef struct {
  const uint16_t *units;
  size_t length;
  size_t at;
  uint32_t folded[PATTERN_MAX_FOLD_LENGTH];
  uint32_t folded_at;
  uint32_t folded_count;
  uint32_t case_fold;
} pattern_text_cursor;

uint32_t pattern_fold_point(uint32_t point, uint32_t *into);
int pattern_text_next(pattern_text_cursor *cursor, uint32_t *point);
narsil_status pattern_text_points(narsil_code_points *out, const uint16_t *units, size_t length, uint32_t case_fold);

#endif
