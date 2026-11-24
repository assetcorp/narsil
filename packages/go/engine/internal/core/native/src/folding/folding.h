#ifndef NARSIL_FOLDING_FOLDING_H
#define NARSIL_FOLDING_FOLDING_H

#include "../analysis/analyser.h"

#include <stddef.h>
#include <stdint.h>

typedef struct {
  uint32_t from;
  uint32_t start;
  uint32_t length;
} narsil_fold_letter;

typedef struct {
  uint8_t folds;
  uint8_t ascii_letters;
  uint32_t letter_count;
  const narsil_fold_letter *letters;
  const uint16_t *units;
} narsil_language_folding;

extern const narsil_language_folding narsil_language_folding_table[];
extern const uint32_t narsil_language_folding_table_length;

int narsil_fold_view(narsil_analyser *analyser, uint32_t language, narsil_unit_view spelling, uint32_t flags,
                     narsil_unit_view *result);

#endif
