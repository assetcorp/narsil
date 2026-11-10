#ifndef NARSIL_ANALYSIS_ANALYSER_H
#define NARSIL_ANALYSIS_ANALYSER_H

#include "../../include/narsil_analysis.h"
#include "languages.h"
#include "normalise.h"
#include "split.h"
#include "stop_words.h"
#include "term_cache.h"
#include "text.h"

#include <stddef.h>
#include <stdint.h>

struct narsil_stop_word_set {
  narsil_stop_words words;
};

typedef struct {
  const uint16_t *units;
  size_t length;
} narsil_unit_view;

struct narsil_analyser {
  narsil_normalise_scratch scratch;
  narsil_text folded;
  narsil_spans parts;
  narsil_spans grams;
  narsil_code_points gram_offsets;
  narsil_text step_a;
  narsil_text step_b;
  narsil_text surface_step;
  narsil_text surface;
  narsil_text arena;
  narsil_token *tokens;
  uint32_t token_count;
  uint32_t token_capacity;
  struct SN_env **snowball;
  narsil_stop_words *default_stop_words;
  uint8_t *default_stop_words_built;
  narsil_term_cache terms;
};

int narsil_transform_token(narsil_analyser *analyser, const narsil_language *language, uint32_t language_index,
                           narsil_unit_view candidate, uint32_t flags, narsil_unit_view *result, uint32_t *term_slot);
int narsil_surface_of(narsil_analyser *analyser, const narsil_language *language, narsil_unit_view candidate,
                      narsil_unit_view *result);
int narsil_stem_token(narsil_analyser *analyser, const narsil_language *language, uint32_t language_index,
                      narsil_unit_view candidate, narsil_unit_view *result);

#endif
