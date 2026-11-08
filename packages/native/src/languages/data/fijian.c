#include "../../analysis/languages.h"
#include "declarations.h"

#include <stddef.h>
#include <stdint.h>

static const uint16_t stop_word_units[142] = {
  97, 117, 98, 97, 108, 101, 116, 97, 100, 117, 97, 101, 101, 110, 97, 101, 114, 97, 103, 97, 105, 97, 105, 107, 111,
  105, 114, 97, 107, 97, 107, 101, 107, 101, 99, 101, 107, 101, 99, 101, 103, 97, 107, 101, 100, 97, 107, 101, 105, 107,
  101, 105, 109, 97, 109, 105, 107, 101, 109, 117, 110, 105, 107, 101, 110, 97, 107, 105, 107, 111, 121, 97, 109, 97,
  105, 109, 101, 110, 97, 110, 105, 110, 111, 100, 114, 97, 110, 111, 109, 117, 110, 111, 110, 97, 110, 111, 113, 117,
  111, 111, 113, 111, 111, 121, 97, 114, 97, 119, 97, 115, 97, 115, 97, 114, 97, 115, 101, 115, 101, 103, 97, 115, 111,
  116, 97, 108, 101, 103, 97, 116, 105, 107, 111, 116, 117, 118, 101, 105, 121, 97, 110, 105,
};

static const uint32_t stop_word_offsets[44] = {
  0, 2, 8, 11, 12, 15, 18, 20, 22, 25, 28, 30, 32, 36, 42, 46, 49, 56, 62, 66, 68, 72, 75, 77, 79, 81, 86, 90, 94, 98,
  99, 102, 105, 109, 111, 115, 117, 121, 123, 129, 133, 135, 138, 142,
};

static const uint32_t keep_ranges[6] = {
  48, 57, 65, 90, 97, 122,
};

const narsil_language narsil_language_fijian = {
  .name = "fijian",
  .revision = "6ad6128c0a054f50",
  .stop_word_units = stop_word_units,
  .stop_word_offsets = stop_word_offsets,
  .stop_word_count = 43,
  .ascii_keep = {0x03FF000000000000ULL, 0x07FFFFFE07FFFFFEULL},
  .keep_ranges = keep_ranges,
  .keep_range_count = 3,
  .splits_code_points = 0,
  .strips_possessive = 0,
  .normalises_diacritics = 0,
  .min_token_length = 1,
  .ngram_size = 0,
  .normalise = NULL,
  .stem_by_rules = NULL,
  .create_snowball = NULL,
  .snowball_stem = NULL,
  .close_snowball = NULL,
};
