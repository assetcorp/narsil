#include "../../analysis/languages.h"
#include "declarations.h"

#include <stddef.h>
#include <stdint.h>

static const uint16_t stop_word_units[137] = {
  3585, 3633, 3609, 3585, 3633, 3610, 3585, 3655, 3586, 3629, 3586, 3638, 3657, 3609, 3588, 3591, 3588, 3639, 3629,
  3592, 3632, 3592, 3633, 3604, 3592, 3638, 3591, 3595, 3638, 3656, 3591, 3604, 3633, 3591, 3605, 3633, 3657, 3591,
  3605, 3656, 3629, 3606, 3638, 3591, 3606, 3641, 3585, 3606, 3657, 3634, 3607, 3633, 3657, 3591, 3607, 3635, 3607,
  3637, 3656, 3607, 3640, 3585, 3607, 3661, 3634, 3609, 3633, 3585, 3609, 3633, 3657, 3609, 3609, 3635, 3609, 3637,
  3657, 3609, 3656, 3634, 3609, 3661, 3634, 3612, 3621, 3614, 3610, 3617, 3634, 3617, 3637, 3618, 3633, 3591, 3619,
  3633, 3610, 3621, 3591, 3623, 3633, 3609, 3623, 3656, 3634, 3626, 3640, 3604, 3626, 3656, 3591, 3629, 3618, 3641,
  3656, 3629, 3637, 3585, 3649, 3605, 3656, 3651, 3609, 3651, 3627, 3657, 3652, 3604, 3657, 3652, 3611, 3652, 3617,
  3656, 3652, 3623, 3657,
};

static const uint32_t stop_word_offsets[49] = {
  0, 3, 6, 8, 10, 14, 16, 19, 21, 24, 27, 31, 34, 38, 41, 44, 47, 50, 54, 56, 59, 62, 65, 68, 72, 74, 77, 80, 83, 85,
  87, 89, 91, 94, 97, 99, 102, 105, 108, 111, 115, 118, 121, 123, 126, 129, 131, 134, 137,
};

static const uint32_t keep_ranges[16] = {
  48, 57, 65, 90, 97, 122, 383, 383, 3585, 3646, 3648, 3662, 3664, 3673, 8490, 8490,
};

const narsil_language narsil_language_thai = {
  .name = "thai",
  .revision = "539a9c751d40b781",
  .stop_word_units = stop_word_units,
  .stop_word_offsets = stop_word_offsets,
  .stop_word_count = 48,
  .ascii_keep = {0x03FF000000000000ULL, 0x07FFFFFE07FFFFFEULL},
  .keep_ranges = keep_ranges,
  .keep_range_count = 8,
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
