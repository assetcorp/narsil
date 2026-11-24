#ifndef NARSIL_FOLDING_H
#define NARSIL_FOLDING_H

#include "narsil_analysis.h"
#include "narsil_core.h"

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define NARSIL_FOLD_STEM (1U << 0)

narsil_status narsil_language_folds(uint32_t language, uint32_t *folds);
narsil_status narsil_fold_spelling(narsil_analyser *analyser, uint32_t language, const uint16_t *units, uint32_t length,
                                   uint32_t flags, narsil_term *term);

#ifdef __cplusplus
}
#endif

#endif
