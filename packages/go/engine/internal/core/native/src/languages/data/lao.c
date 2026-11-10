#include "../../analysis/languages.h"
#include "declarations.h"

#include <stddef.h>
#include <stdint.h>

static const uint16_t stop_word_units[137] = {
  3713, 3761, 3737, 3713, 3761, 3738, 3713, 3789, 3714, 3766, 3785, 3737, 3714, 3789, 3716, 3761, 3785, 3719, 3716,
  3767, 3716, 3771, 3719, 3720, 3760, 3720, 3761, 3732, 3720, 3766, 3784, 3719, 3725, 3761, 3719, 3732, 3761, 3719,
  3733, 3761, 3785, 3719, 3733, 3789, 3784, 3734, 3767, 3713, 3734, 3785, 3762, 3735, 3761, 3719, 3735, 3765, 3784,
  3735, 3768, 3713, 3737, 3761, 3713, 3737, 3761, 3785, 3737, 3737, 3765, 3785, 3737, 3789, 3762, 3738, 3789, 3784,
  3740, 3771, 3737, 3742, 3771, 3738, 3745, 3762, 3745, 3765, 3745, 3767, 3785, 3746, 3769, 3784, 3749, 3771, 3719,
  3751, 3784, 3762, 3754, 3764, 3784, 3719, 3754, 3768, 3732, 3754, 3771, 3784, 3719, 3755, 3749, 3767, 3755, 3772,
  3767, 3757, 3765, 3713, 3758, 3761, 3738, 3777, 3733, 3784, 3779, 3737, 3779, 3755, 3785, 3780, 3732, 3785, 3780,
  3739, 3780, 3751, 3785,
};

static const uint32_t stop_word_offsets[47] = {
  0, 3, 6, 8, 12, 14, 18, 20, 23, 25, 28, 32, 35, 38, 42, 45, 48, 51, 54, 57, 60, 63, 67, 70, 73, 76, 79, 82, 84, 86,
  89, 92, 95, 98, 102, 105, 109, 112, 115, 118, 121, 124, 126, 129, 132, 134, 137,
};

static const uint32_t keep_ranges[12] = {
  48, 57, 65, 90, 97, 122, 383, 383, 3713, 3807, 8490, 8490,
};

const narsil_language narsil_language_lao = {
  .name = "lao",
  .revision = "b0741c0490fc12dc",
  .stop_word_units = stop_word_units,
  .stop_word_offsets = stop_word_offsets,
  .stop_word_count = 46,
  .ascii_keep = {0x03FF000000000000ULL, 0x07FFFFFE07FFFFFEULL},
  .keep_ranges = keep_ranges,
  .keep_range_count = 6,
  .splits_code_points = 1,
  .strips_possessive = 0,
  .normalises_diacritics = 0,
  .min_token_length = 1,
  .ngram_size = 2,
  .normalise = NULL,
  .stem_by_rules = NULL,
  .create_snowball = NULL,
  .snowball_stem = NULL,
  .close_snowball = NULL,
};
