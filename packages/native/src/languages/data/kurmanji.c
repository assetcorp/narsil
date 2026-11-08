#include "../../analysis/languages.h"
#include "declarations.h"

#include <stddef.h>
#include <stdint.h>

static const uint16_t stop_word_units[100] = {
  98, 105, 100, 97, 100, 101, 100, 105, 101, 109, 101, 118, 101, 119, 101, 122, 103, 101, 108, 101, 107, 104, 101, 109,
  251, 104, 101, 114, 104, 105, 110, 104, 251, 110, 106, 105, 107, 101, 110, 103, 238, 107, 101, 115, 107, 117, 107,
  234, 107, 238, 108, 105, 109, 101, 109, 105, 110, 116, 101, 116, 105, 351, 116, 116, 117, 118, 97, 118, 234, 118, 238,
  119, 97, 110, 119, 101, 119, 234, 119, 238, 231, 97, 119, 97, 231, 101, 110, 100, 231, 105, 231, 105, 109, 97, 231,
  105, 113, 97, 115, 251,
};

static const uint32_t stop_word_offsets[39] = {
  0, 2, 4, 6, 8, 10, 12, 14, 16, 21, 25, 28, 31, 34, 36, 41, 44, 46, 48, 50, 52, 54, 57, 59, 63, 65, 67, 69, 71, 74, 76,
  78, 80, 84, 88, 90, 94, 99, 100,
};

static const uint32_t keep_ranges[24] = {
  48, 57, 65, 90, 97, 122, 199, 199, 202, 202, 206, 206, 219, 219, 231, 231, 234, 234, 238, 238, 251, 251, 350, 351,
};

const narsil_language narsil_language_kurmanji = {
  .name = "kurmanji",
  .revision = "0a3b2b568824d7c6",
  .stop_word_units = stop_word_units,
  .stop_word_offsets = stop_word_offsets,
  .stop_word_count = 38,
  .ascii_keep = {0x03FF000000000000ULL, 0x07FFFFFE07FFFFFEULL},
  .keep_ranges = keep_ranges,
  .keep_range_count = 12,
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
