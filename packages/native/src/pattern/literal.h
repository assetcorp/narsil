#ifndef NARSIL_PATTERN_LITERAL_H
#define NARSIL_PATTERN_LITERAL_H

#include "../../include/narsil_core.h"
#include "../work/tally.h"
#include "text.h"

#include <stddef.h>
#include <stdint.h>

typedef struct {
  uint32_t *allocation;
  size_t capacity;
  const uint32_t *points;
  uint32_t length;
  uint32_t *borders;
  uint32_t *reachable;
  uint32_t anchored_start;
  uint32_t anchored_end;
} pattern_literal;

narsil_status pattern_literal_prepare(pattern_literal *literal, const uint32_t *points, uint32_t length);
int pattern_literal_match(const pattern_literal *literal, pattern_text_cursor *value, work_tally *tally);

#endif
