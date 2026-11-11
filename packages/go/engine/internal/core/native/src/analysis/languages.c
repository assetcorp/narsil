#include "languages.h"

#include "../../include/narsil_analysis.h"
#include "../../include/narsil_core.h"
#include "text.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

#define ASCII_KEEP_WORD_BITS 64U
#define KEEP_RANGE_STRIDE 2U

static int compare_name(const char *candidate, const char *name, size_t length) {
  size_t candidate_length = strlen(candidate);
  size_t shared = candidate_length < length ? candidate_length : length;
  int order = memcmp(candidate, name, shared);
  if (order != 0) { return order; }
  return (candidate_length > length) - (candidate_length < length);
}

narsil_status narsil_language_lookup(const char *name, size_t length, uint32_t *language) {
  if (name == NULL || language == NULL) { return NARSIL_INVALID_ARGUMENT; }
  uint32_t low = 0;
  uint32_t high = narsil_language_table_length;
  while (low < high) {
    uint32_t middle = low + ((high - low) / 2);
    int order = compare_name(narsil_language_table[middle]->name, name, length);
    if (order == 0) {
      *language = middle;
      return NARSIL_OK;
    }
    if (order < 0) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return NARSIL_INVALID_ARGUMENT;
}

uint32_t narsil_language_count(void) { return narsil_language_table_length; }

const char *narsil_language_name(uint32_t language) {
  return language < narsil_language_table_length ? narsil_language_table[language]->name : NULL;
}

const char *narsil_language_revision(uint32_t language) {
  return language < narsil_language_table_length ? narsil_language_table[language]->revision : NULL;
}

narsil_status narsil_language_stop_words(uint32_t language, narsil_word_list *words) {
  if (words == NULL || language >= narsil_language_table_length) { return NARSIL_INVALID_ARGUMENT; }
  const narsil_language *module = narsil_language_table[language];
  words->units = module->stop_word_units;
  words->offsets = module->stop_word_offsets;
  words->count = module->stop_word_count;
  return NARSIL_OK;
}

int narsil_language_keeps(const narsil_language *language, uint32_t code_point) {
  if (code_point < NARSIL_ASCII_END) {
    return (int)((language->ascii_keep[code_point / ASCII_KEEP_WORD_BITS] >> (code_point % ASCII_KEEP_WORD_BITS)) & 1U);
  }
  uint32_t low = 0;
  uint32_t high = language->keep_range_count;
  while (low < high) {
    uint32_t middle = low + ((high - low) / 2);
    const uint32_t *range = &language->keep_ranges[(size_t)middle * KEEP_RANGE_STRIDE];
    if (code_point < range[0]) {
      high = middle;
    } else if (code_point > range[1]) {
      low = middle + 1;
    } else {
      return 1;
    }
  }
  return 0;
}
