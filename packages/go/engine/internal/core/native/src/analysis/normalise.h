#ifndef NARSIL_ANALYSIS_NORMALISE_H
#define NARSIL_ANALYSIS_NORMALISE_H

#include "text.h"

#include <stddef.h>
#include <stdint.h>

typedef struct {
  narsil_text first;
  narsil_text second;
  narsil_code_points points;
} narsil_normalise_scratch;

typedef int (*narsil_mark_test)(uint32_t code_point);

void narsil_normalise_scratch_release(narsil_normalise_scratch *scratch);
uint16_t narsil_fold_width(uint16_t unit);
uint32_t narsil_fold_form(uint32_t point);

int narsil_nfd(const uint16_t *units, size_t length, narsil_text *out, narsil_code_points *points);
int narsil_nfc(const uint16_t *units, size_t length, narsil_text *out, narsil_code_points *points);
int narsil_lowercase(const uint16_t *units, size_t length, narsil_text *out);
int narsil_fold_for_splitting(const uint16_t *units, size_t length, narsil_text *out,
                              narsil_normalise_scratch *scratch);
int narsil_strip_diacritics(const uint16_t *units, size_t length, narsil_text *out, narsil_code_points *points);
int narsil_remove_marks(const uint16_t *units, size_t length, narsil_mark_test is_removed, narsil_text *out,
                        narsil_normalise_scratch *scratch);

#endif
