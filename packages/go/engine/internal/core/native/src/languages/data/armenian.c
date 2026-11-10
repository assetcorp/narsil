#include "../../analysis/languages.h"
#include "declarations.h"
#include "../snowball/armenian_stemmer.h"

#include <stddef.h>
#include <stdint.h>

static const uint16_t stop_word_units[126] = {
  1377, 1397, 1380, 1377, 1397, 1388, 1377, 1397, 1398, 1377, 1397, 1405, 1380, 1400, 1410, 1380, 1400, 1410, 1412,
  1381, 1396, 1381, 1398, 1381, 1398, 1412, 1381, 1405, 1381, 1412, 1383, 1383, 1387, 1383, 1387, 1398, 1383, 1387,
  1398, 1412, 1383, 1387, 1408, 1383, 1387, 1412, 1383, 1408, 1384, 1405, 1407, 1385, 1387, 1387, 1398, 1387, 1405,
  1391, 1387, 1408, 1391, 1377, 1396, 1392, 1377, 1396, 1377, 1408, 1392, 1381, 1407, 1392, 1381, 1407, 1400, 1396,
  1381, 1398, 1412, 1396, 1381, 1403, 1396, 1387, 1398, 1398, 1377, 1398, 1377, 1415, 1398, 1408, 1377, 1398, 1408,
  1377, 1398, 1412, 1400, 1408, 1400, 1408, 1384, 1400, 1408, 1400, 1398, 1412, 1400, 1408, 1402, 1381, 1405, 1400,
  1410, 1400, 1410, 1396, 1402, 1387, 1407, 1387, 1406, 1408, 1377, 1415,
};

static const uint32_t stop_word_offsets[46] = {
  0, 3, 6, 9, 12, 15, 19, 21, 23, 26, 28, 30, 31, 33, 36, 40, 43, 46, 48, 51, 52, 53, 55, 58, 60, 63, 68, 71, 75, 79,
  82, 84, 85, 87, 90, 93, 98, 100, 103, 108, 113, 115, 118, 122, 125, 126,
};

static const uint32_t keep_ranges[10] = {
  48, 57, 65, 90, 97, 122, 1329, 1366, 1377, 1415,
};

const narsil_language narsil_language_armenian = {
  .name = "armenian",
  .revision = "6d99ac3501d5d369",
  .stop_word_units = stop_word_units,
  .stop_word_offsets = stop_word_offsets,
  .stop_word_count = 45,
  .ascii_keep = {0x03FF000000000000ULL, 0x07FFFFFE07FFFFFEULL},
  .keep_ranges = keep_ranges,
  .keep_range_count = 5,
  .splits_code_points = 0,
  .strips_possessive = 0,
  .normalises_diacritics = 0,
  .min_token_length = 1,
  .ngram_size = 0,
  .normalise = NULL,
  .stem_by_rules = NULL,
  .create_snowball = armenian_create_env,
  .snowball_stem = armenian_stem,
  .close_snowball = armenian_close_env,
};
