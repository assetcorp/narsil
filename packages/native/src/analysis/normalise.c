#include "normalise.h"

#include "../../include/narsil_core.h"
#include "text.h"
#include "unicode.h"

#include <stddef.h>
#include <stdint.h>

#define CAPITAL_SIGMA 0x3A3U
#define SMALL_FINAL_SIGMA 0x3C2U
#define ASCII_CAPITAL_A 0x41U
#define ASCII_CAPITAL_Z 0x5AU
#define ASCII_CASE_OFFSET 0x20U
#define APOSTROPHE 0x27U
#define LATIN_SMALL_I 0x69U
#define COMBINING_DOT_ABOVE 0x307U
#define DOTTED_CAPITAL_I 0x130U
#define ARMENIAN_MARKS_FIRST 0x55BU
#define ARMENIAN_MARKS_LAST 0x55FU
#define LEFT_SINGLE_QUOTE 0x2018U
#define RIGHT_SINGLE_QUOTE 0x2019U
#define MODIFIER_APOSTROPHE 0x2BCU
#define MODIFIER_TURNED_COMMA 0x2BBU
#define FULLWIDTH_ASCII_FIRST 0xFF01U
#define FULLWIDTH_ASCII_LAST 0xFF5EU
#define FULLWIDTH_ASCII_OFFSET 0xFEE0U
#define HALFWIDTH_KANA_FIRST 0xFF61U
#define HALFWIDTH_KANA_LAST 0xFF9DU
#define HALFWIDTH_VOICED_MARK 0xFF9EU
#define HALFWIDTH_SEMI_VOICED_MARK 0xFF9FU
#define COMBINING_VOICED_MARK 0x3099U
#define COMBINING_SEMI_VOICED_MARK 0x309AU
#define COMBINING_DIACRITICS_FIRST 0x300U
#define COMBINING_DIACRITICS_LAST 0x36FU
#define NON_STARTER_BEFORE_ANY_STARTER 256U

static const uint16_t halfwidth_kana_targets[HALFWIDTH_KANA_LAST - HALFWIDTH_KANA_FIRST + 1] = {
    0x3002, 0x300C, 0x300D, 0x3001, 0x30FB, 0x30F2, 0x30A1, 0x30A3, 0x30A5, 0x30A7, 0x30A9, 0x30E3, 0x30E5,
    0x30E7, 0x30C3, 0x30FC, 0x30A2, 0x30A4, 0x30A6, 0x30A8, 0x30AA, 0x30AB, 0x30AD, 0x30AF, 0x30B1, 0x30B3,
    0x30B5, 0x30B7, 0x30B9, 0x30BB, 0x30BD, 0x30BF, 0x30C1, 0x30C4, 0x30C6, 0x30C8, 0x30CA, 0x30CB, 0x30CC,
    0x30CD, 0x30CE, 0x30CF, 0x30D2, 0x30D5, 0x30D8, 0x30DB, 0x30DE, 0x30DF, 0x30E0, 0x30E1, 0x30E2, 0x30E4,
    0x30E6, 0x30E8, 0x30E9, 0x30EA, 0x30EB, 0x30EC, 0x30ED, 0x30EF, 0x30F3,
};

void narsil_normalise_scratch_release(narsil_normalise_scratch *scratch) {
  narsil_text_release(&scratch->first);
  narsil_text_release(&scratch->second);
  narsil_code_points_release(&scratch->points);
}

static void reorder_canonically(uint32_t *values, size_t length) {
  for (size_t i = 1; i < length; i++) {
    uint32_t value = values[i];
    uint32_t value_class = narsil_unicode_combining_class(value);
    if (value_class == 0) { continue; }
    size_t position = i;
    while (position > 0) {
      uint32_t before_class = narsil_unicode_combining_class(values[position - 1]);
      if (before_class <= value_class) { break; }
      values[position] = values[position - 1];
      position--;
    }
    values[position] = value;
  }
}

static int decompose_text(const uint16_t *units, size_t length, narsil_code_points *points) {
  points->length = 0;
  int status = narsil_code_points_reserve(points, length);
  if (status != NARSIL_OK) { return status; }
  uint32_t parts[NARSIL_UNICODE_MAX_DECOMPOSITION];
  size_t index = 0;
  while (index < length) {
    uint32_t count = narsil_unicode_decompose(narsil_decode_next(units, length, &index), parts);
    for (uint32_t part = 0; part < count; part++) {
      status = narsil_code_points_push(points, parts[part]);
      if (status != NARSIL_OK) { return status; }
    }
  }
  reorder_canonically(points->values, points->length);
  return NARSIL_OK;
}

static size_t compose_in_place(uint32_t *values, size_t length) {
  if (length == 0) { return 0; }
  size_t starter_position = 0;
  uint32_t starter = values[0];
  uint32_t last_class = narsil_unicode_combining_class(starter);
  if (last_class != 0) { last_class = NON_STARTER_BEFORE_ANY_STARTER; }
  size_t kept = 1;
  for (size_t i = 1; i < length; i++) {
    uint32_t value = values[i];
    uint32_t value_class = narsil_unicode_combining_class(value);
    uint32_t composite = narsil_unicode_compose(starter, value);
    if (composite != NARSIL_UNICODE_NO_COMPOSITE && (last_class < value_class || last_class == 0)) {
      values[starter_position] = composite;
      starter = composite;
      continue;
    }
    if (value_class == 0) {
      starter_position = kept;
      starter = value;
    }
    last_class = value_class;
    values[kept++] = value;
  }
  return kept;
}

static int encode_points(const uint32_t *values, size_t length, narsil_text *out) {
  out->length = 0;
  int status = narsil_text_reserve(out, length);
  for (size_t i = 0; i < length && status == NARSIL_OK; i++) { status = narsil_text_push_code_point(out, values[i]); }
  return status;
}

int narsil_nfd(const uint16_t *units, size_t length, narsil_text *out, narsil_code_points *points) {
  int status = decompose_text(units, length, points);
  if (status != NARSIL_OK) { return status; }
  return encode_points(points->values, points->length, out);
}

int narsil_nfc(const uint16_t *units, size_t length, narsil_text *out, narsil_code_points *points) {
  int status = decompose_text(units, length, points);
  if (status != NARSIL_OK) { return status; }
  points->length = compose_in_place(points->values, points->length);
  return encode_points(points->values, points->length, out);
}

static int cased_letter_beside(const uint16_t *units, size_t length, size_t index, int forward) {
  while (forward ? index < length : index > 0) {
    uint32_t code_point = forward ? narsil_decode_next(units, length, &index) : narsil_decode_previous(units, &index);
    uint32_t properties = narsil_unicode_properties(code_point);
    if ((properties & NARSIL_UNICODE_CASE_IGNORABLE) != 0) { continue; }
    return (properties & NARSIL_UNICODE_CASED) != 0;
  }
  return 0;
}

int narsil_lowercase(const uint16_t *units, size_t length, narsil_text *out) {
  out->length = 0;
  int status = narsil_text_reserve(out, length);
  size_t index = 0;
  while (index < length && status == NARSIL_OK) {
    size_t start = index;
    uint32_t code_point = narsil_decode_next(units, length, &index);
    if (code_point == CAPITAL_SIGMA && cased_letter_beside(units, length, start, 0) &&
        !cased_letter_beside(units, length, index, 1)) {
      status = narsil_text_push(out, SMALL_FINAL_SIGMA);
      continue;
    }
    uint32_t second = 0;
    uint32_t lower = narsil_unicode_lowercase_of(code_point, &second);
    status = narsil_text_push_code_point(out, lower);
    if (status == NARSIL_OK && second != 0) { status = narsil_text_push_code_point(out, second); }
  }
  return status;
}

static uint16_t fold_width(uint16_t unit) {
  if (unit >= FULLWIDTH_ASCII_FIRST && unit <= FULLWIDTH_ASCII_LAST) {
    return (uint16_t)(unit - FULLWIDTH_ASCII_OFFSET);
  }
  if (unit >= HALFWIDTH_KANA_FIRST && unit <= HALFWIDTH_KANA_LAST) {
    return halfwidth_kana_targets[unit - HALFWIDTH_KANA_FIRST];
  }
  if (unit == HALFWIDTH_VOICED_MARK) { return COMBINING_VOICED_MARK; }
  if (unit == HALFWIDTH_SEMI_VOICED_MARK) { return COMBINING_SEMI_VOICED_MARK; }
  return unit;
}

static int fold_forms(const narsil_text *source, narsil_text *out) {
  out->length = 0;
  int status = narsil_text_reserve(out, source->length);
  for (size_t i = 0; i < source->length && status == NARSIL_OK; i++) {
    uint16_t unit = source->units[i];
    if (unit == COMBINING_DOT_ABOVE || (unit >= ARMENIAN_MARKS_FIRST && unit <= ARMENIAN_MARKS_LAST)) { continue; }
    if (unit == DOTTED_CAPITAL_I) {
      status = narsil_text_push(out, LATIN_SMALL_I);
    } else if (unit == LEFT_SINGLE_QUOTE || unit == RIGHT_SINGLE_QUOTE || unit == MODIFIER_APOSTROPHE ||
               unit == MODIFIER_TURNED_COMMA) {
      status = narsil_text_push(out, APOSTROPHE);
    } else {
      status = narsil_text_push(out, unit);
    }
  }
  return status;
}

int narsil_fold_for_splitting(const uint16_t *units, size_t length, narsil_text *out,
                              narsil_normalise_scratch *scratch) {
  if (narsil_units_are_ascii(units, length)) {
    out->length = 0;
    int status = narsil_text_reserve(out, length);
    if (status != NARSIL_OK) { return status; }
    for (size_t i = 0; i < length; i++) {
      uint16_t unit = units[i];
      out->units[i] = unit >= ASCII_CAPITAL_A && unit <= ASCII_CAPITAL_Z ? (uint16_t)(unit + ASCII_CASE_OFFSET) : unit;
    }
    out->length = length;
    return NARSIL_OK;
  }
  scratch->first.length = 0;
  int status = narsil_text_reserve(&scratch->first, length);
  if (status != NARSIL_OK) { return status; }
  for (size_t i = 0; i < length; i++) { scratch->first.units[i] = fold_width(units[i]); }
  scratch->first.length = length;
  status = narsil_nfc(scratch->first.units, scratch->first.length, &scratch->second, &scratch->points);
  if (status == NARSIL_OK) { status = fold_forms(&scratch->second, &scratch->first); }
  if (status == NARSIL_OK) { status = narsil_lowercase(scratch->first.units, scratch->first.length, out); }
  return status;
}

static int is_combining_diacritic(uint32_t code_point) {
  return code_point >= COMBINING_DIACRITICS_FIRST && code_point <= COMBINING_DIACRITICS_LAST;
}

int narsil_strip_diacritics(const uint16_t *units, size_t length, narsil_text *out, narsil_code_points *points) {
  int status = decompose_text(units, length, points);
  if (status != NARSIL_OK) { return status; }
  size_t kept = 0;
  for (size_t i = 0; i < points->length; i++) {
    if (!is_combining_diacritic(points->values[i])) { points->values[kept++] = points->values[i]; }
  }
  return encode_points(points->values, kept, out);
}

int narsil_remove_marks(const uint16_t *units, size_t length, narsil_mark_test is_removed, narsil_text *out,
                        narsil_normalise_scratch *scratch) {
  if (narsil_units_are_ascii(units, length)) { return narsil_text_assign(out, units, length); }
  int status = decompose_text(units, length, &scratch->points);
  if (status != NARSIL_OK) { return status; }
  size_t kept = 0;
  for (size_t i = 0; i < scratch->points.length; i++) {
    if (!is_removed(scratch->points.values[i])) { scratch->points.values[kept++] = scratch->points.values[i]; }
  }
  if (kept == scratch->points.length) { return narsil_text_assign(out, units, length); }
  status = encode_points(scratch->points.values, kept, &scratch->first);
  if (status != NARSIL_OK) { return status; }
  return narsil_nfc(scratch->first.units, scratch->first.length, out, &scratch->points);
}
