#ifndef NARSIL_LANGUAGES_RULES_H
#define NARSIL_LANGUAGES_RULES_H

#include "../analysis/normalise.h"
#include "../analysis/text.h"

#include <stddef.h>
#include <stdint.h>

#define NARSIL_SUBSTITUTION_MAX_UNITS 2U

typedef struct {
  uint16_t first;
  uint16_t last;
  uint8_t length;
  uint16_t replacement[NARSIL_SUBSTITUTION_MAX_UNITS];
} narsil_unit_substitution;

typedef struct {
  const uint16_t *units;
  size_t length;
} narsil_rule_word;

int narsil_substitute_units(const uint16_t *units, size_t length, const narsil_unit_substitution *substitutions,
                            size_t substitution_count, narsil_text *out);
size_t narsil_rule_length(const uint16_t *literal);
int narsil_rule_ends_with(const narsil_text *word, const uint16_t *suffix);
int narsil_rule_starts_with(const narsil_text *word, const uint16_t *prefix);
int narsil_rule_ends_with_unit(const narsil_text *word, uint16_t unit);
size_t narsil_rule_code_point_count(const uint16_t *units, size_t length);

int narsil_bulgarian_normalise(const uint16_t *units, size_t length, narsil_text *out,
                               narsil_normalise_scratch *scratch);
int narsil_danish_normalise(const uint16_t *units, size_t length, narsil_text *out, narsil_normalise_scratch *scratch);
int narsil_greek_normalise(const uint16_t *units, size_t length, narsil_text *out, narsil_normalise_scratch *scratch);
int narsil_latin_normalise(const uint16_t *units, size_t length, narsil_text *out, narsil_normalise_scratch *scratch);
int narsil_macedonian_normalise(const uint16_t *units, size_t length, narsil_text *out,
                                narsil_normalise_scratch *scratch);
int narsil_portuguese_normalise(const uint16_t *units, size_t length, narsil_text *out,
                                narsil_normalise_scratch *scratch);
int narsil_slovenian_normalise(const uint16_t *units, size_t length, narsil_text *out,
                               narsil_normalise_scratch *scratch);

int narsil_dagbani_normalise(const uint16_t *units, size_t length, narsil_text *out, narsil_normalise_scratch *scratch);
int narsil_ewe_normalise(const uint16_t *units, size_t length, narsil_text *out, narsil_normalise_scratch *scratch);
int narsil_german_normalise(const uint16_t *units, size_t length, narsil_text *out, narsil_normalise_scratch *scratch);
int narsil_guarani_normalise(const uint16_t *units, size_t length, narsil_text *out, narsil_normalise_scratch *scratch);
int narsil_hebrew_normalise(const uint16_t *units, size_t length, narsil_text *out, narsil_normalise_scratch *scratch);
int narsil_persian_normalise(const uint16_t *units, size_t length, narsil_text *out, narsil_normalise_scratch *scratch);
int narsil_romanian_normalise(const uint16_t *units, size_t length, narsil_text *out,
                              narsil_normalise_scratch *scratch);
int narsil_serbian_normalise(const uint16_t *units, size_t length, narsil_text *out, narsil_normalise_scratch *scratch);
int narsil_sinhala_normalise(const uint16_t *units, size_t length, narsil_text *out, narsil_normalise_scratch *scratch);
int narsil_telugu_normalise(const uint16_t *units, size_t length, narsil_text *out, narsil_normalise_scratch *scratch);
int narsil_twi_normalise(const uint16_t *units, size_t length, narsil_text *out, narsil_normalise_scratch *scratch);

int narsil_hindi_normalise(const uint16_t *units, size_t length, narsil_text *out, narsil_normalise_scratch *scratch);
int narsil_malayalam_normalise(const uint16_t *units, size_t length, narsil_text *out,
                               narsil_normalise_scratch *scratch);
int narsil_sorani_normalise(const uint16_t *units, size_t length, narsil_text *out, narsil_normalise_scratch *scratch);

int narsil_bulgarian_stem(const uint16_t *units, size_t length, narsil_text *out, narsil_normalise_scratch *scratch);
int narsil_sanskrit_stem(const uint16_t *units, size_t length, narsil_text *out, narsil_normalise_scratch *scratch);
int narsil_slovenian_stem(const uint16_t *units, size_t length, narsil_text *out, narsil_normalise_scratch *scratch);
int narsil_swahili_stem(const uint16_t *units, size_t length, narsil_text *out, narsil_normalise_scratch *scratch);
int narsil_ukrainian_stem(const uint16_t *units, size_t length, narsil_text *out, narsil_normalise_scratch *scratch);

#endif
