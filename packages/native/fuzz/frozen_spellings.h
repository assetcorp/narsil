#ifndef NARSIL_FUZZ_FROZEN_SPELLINGS_H
#define NARSIL_FUZZ_FROZEN_SPELLINGS_H

#include "frozen_segment.h"
#include "input.h"

#include <stddef.h>
#include <stdint.h>

enum {
  FUZZ_FROZEN_LETTERS = 4,
  FUZZ_FROZEN_FIRST_LETTER = 'a',
  FUZZ_FROZEN_RUN_POINTS = 3,
  FUZZ_FROZEN_MAX_RUN_PAIRS = FUZZ_FROZEN_MAX_SPELLINGS * (FUZZ_FROZEN_MAX_WORD_UNITS - FUZZ_FROZEN_RUN_POINTS + 1)
};

typedef struct {
  uint32_t points[FUZZ_FROZEN_RUN_POINTS];
  uint32_t entry;
} fuzz_frozen_run;

void fuzz_frozen_choose_spellings(fuzz_input *input, fuzz_frozen *frozen, size_t terms);
size_t fuzz_frozen_collect_runs(const fuzz_frozen *frozen, fuzz_frozen_run *pairs);

#endif
