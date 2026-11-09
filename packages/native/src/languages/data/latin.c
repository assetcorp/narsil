#include "../../analysis/languages.h"
#include "declarations.h"
#include "../rules.h"

#include <stddef.h>
#include <stdint.h>

static const uint16_t stop_word_units[159] = {
  97, 97, 98, 97, 99, 97, 100, 97, 116, 97, 116, 113, 117, 101, 97, 117, 116, 97, 117, 116, 101, 109, 99, 117, 109, 100,
  101, 100, 117, 109, 101, 101, 114, 97, 110, 116, 101, 114, 97, 116, 101, 115, 116, 101, 116, 101, 116, 105, 97, 109,
  101, 120, 104, 97, 101, 99, 104, 105, 99, 104, 111, 99, 105, 110, 105, 116, 97, 109, 101, 110, 101, 99, 110, 101, 113,
  117, 101, 110, 111, 110, 112, 101, 114, 113, 117, 97, 113, 117, 97, 101, 113, 117, 97, 109, 113, 117, 105, 113, 117,
  105, 98, 117, 115, 113, 117, 105, 100, 101, 109, 113, 117, 111, 113, 117, 111, 100, 114, 101, 114, 101, 98, 117, 115,
  114, 101, 109, 114, 101, 115, 115, 101, 100, 115, 105, 115, 105, 99, 115, 117, 110, 116, 116, 97, 109, 101, 110, 116,
  97, 110, 100, 101, 109, 116, 101, 117, 116, 118, 101, 108,
};

static const uint32_t stop_word_offsets[50] = {
  0, 1, 3, 5, 7, 9, 14, 17, 22, 25, 27, 30, 31, 36, 40, 43, 45, 50, 52, 56, 59, 62, 64, 67, 69, 72, 77, 80, 83, 86, 90,
  94, 97, 103, 109, 112, 116, 118, 123, 126, 129, 132, 134, 137, 141, 146, 152, 154, 156, 159,
};

static const uint32_t keep_ranges[16] = {
  48, 57, 65, 90, 97, 122, 256, 257, 274, 275, 298, 299, 332, 333, 362, 363,
};

const narsil_language narsil_language_latin = {
  .name = "latin",
  .revision = "742d28d082ca56cc",
  .stop_word_units = stop_word_units,
  .stop_word_offsets = stop_word_offsets,
  .stop_word_count = 49,
  .ascii_keep = {0x03FF000000000000ULL, 0x07FFFFFE07FFFFFEULL},
  .keep_ranges = keep_ranges,
  .keep_range_count = 8,
  .splits_code_points = 0,
  .strips_possessive = 0,
  .normalises_diacritics = 0,
  .min_token_length = 1,
  .ngram_size = 0,
  .normalise = narsil_latin_normalise,
  .stem_by_rules = NULL,
  .create_snowball = NULL,
  .snowball_stem = NULL,
  .close_snowball = NULL,
};
