#ifndef NARSIL_ANALYSIS_LANGUAGES_H
#define NARSIL_ANALYSIS_LANGUAGES_H

#include "../languages/snowball/api.h"
#include "normalise.h"
#include "text.h"

#include <stddef.h>
#include <stdint.h>

#define NARSIL_ASCII_KEEP_WORDS 2

typedef int (*narsil_token_rewrite)(const uint16_t *units, size_t length, narsil_text *out,
                                    narsil_normalise_scratch *scratch);

typedef struct {
  const char *name;
  const char *revision;
  const uint16_t *stop_word_units;
  const uint32_t *stop_word_offsets;
  uint32_t stop_word_count;
  uint64_t ascii_keep[NARSIL_ASCII_KEEP_WORDS];
  const uint32_t *keep_ranges;
  uint32_t keep_range_count;
  uint8_t splits_code_points;
  uint8_t strips_possessive;
  uint8_t normalises_diacritics;
  uint32_t min_token_length;
  uint32_t ngram_size;
  narsil_token_rewrite normalise;
  narsil_token_rewrite stem_by_rules;
  struct SN_env *(*create_snowball)(void);
  int (*snowball_stem)(struct SN_env *env);
  void (*close_snowball)(struct SN_env *env);
} narsil_language;

extern const narsil_language *const narsil_language_table[];
extern const uint32_t narsil_language_table_length;

int narsil_language_keeps(const narsil_language *language, uint32_t code_point);

#endif
