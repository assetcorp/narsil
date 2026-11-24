#include "folding.h"

#include "../../include/narsil_analysis.h"
#include "../../include/narsil_core.h"
#include "../../include/narsil_folding.h"
#include "../analysis/analyser.h"
#include "../analysis/languages.h"
#include "../analysis/normalise.h"
#include "../analysis/text.h"

#include <stddef.h>
#include <stdint.h>

static int table_matches_languages(void) { return narsil_language_folding_table_length == narsil_language_count(); }

narsil_status narsil_language_folds(uint32_t language, uint32_t *folds) {
  if (folds == NULL || !table_matches_languages() || language >= narsil_language_folding_table_length) {
    return NARSIL_INVALID_ARGUMENT;
  }
  *folds = narsil_language_folding_table[language].folds;
  return NARSIL_OK;
}

static const narsil_fold_letter *letter_of(const narsil_language_folding *folding, uint32_t point) {
  uint32_t low = 0;
  uint32_t high = folding->letter_count;
  while (low < high) {
    uint32_t middle = low + ((high - low) / 2);
    const narsil_fold_letter *letter = &folding->letters[middle];
    if (letter->from == point) { return letter; }
    if (letter->from < point) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return NULL;
}

static int replace_letters(const narsil_language_folding *folding, narsil_unit_view source, narsil_text *out) {
  out->length = 0;
  size_t index = 0;
  while (index < source.length) {
    size_t start = index;
    uint32_t point = narsil_decode_next(source.units, source.length, &index);
    const narsil_fold_letter *letter = letter_of(folding, point);
    int status = letter == NULL ? narsil_text_append(out, source.units + start, index - start)
                                : narsil_text_append(out, folding->units + letter->start, letter->length);
    if (status != NARSIL_OK) { return status; }
  }
  return NARSIL_OK;
}

int narsil_fold_view(narsil_analyser *analyser, uint32_t language, narsil_unit_view spelling, uint32_t flags,
                     narsil_unit_view *result) {
  const narsil_language_folding *folding = &narsil_language_folding_table[language];
  narsil_unit_view current = spelling;
  if (folding->ascii_letters || !narsil_units_are_ascii(spelling.units, spelling.length)) {
    int status = narsil_strip_diacritics(spelling.units, spelling.length, &analyser->step_a, &analyser->scratch.points);
    if (status != NARSIL_OK) { return status; }
    current.units = analyser->step_a.units;
    current.length = analyser->step_a.length;
    if (folding->letter_count > 0) {
      status = replace_letters(folding, current, &analyser->step_b);
      if (status != NARSIL_OK) { return status; }
      current.units = analyser->step_b.units;
      current.length = analyser->step_b.length;
    }
  }
  if ((flags & NARSIL_FOLD_STEM) != 0) {
    return narsil_stem_token(analyser, narsil_language_table[language], language, current, result);
  }
  *result = current;
  return NARSIL_OK;
}

narsil_status narsil_fold_spelling(narsil_analyser *analyser, uint32_t language, const uint16_t *units, uint32_t length,
                                   uint32_t flags, narsil_term *term) {
  if (analyser == NULL || term == NULL || (units == NULL && length > 0) || length > NARSIL_MAX_ANALYSED_UNITS ||
      (flags & ~NARSIL_FOLD_STEM) != 0 || !table_matches_languages() ||
      language >= narsil_language_folding_table_length) {
    return NARSIL_INVALID_ARGUMENT;
  }
  narsil_unit_view spelling = {units, length};
  narsil_unit_view result = {NULL, 0};
  int status = narsil_fold_view(analyser, language, spelling, flags, &result);
  if (status != NARSIL_OK) { return (narsil_status)status; }
  term->units = result.units;
  term->length = (uint32_t)result.length;
  return NARSIL_OK;
}
