#include "split.h"

#include "../../include/narsil_core.h"
#include "../allocation.h"
#include "languages.h"
#include "text.h"
#include "unicode.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

#define MIN_SPANS 16U

#define PROLONGED_SOUND_MARK 0x30FCU
#define IDEOGRAPHIC_ITERATION_MARK 0x3005U
#define LOWEST_NGRAM_CODE_POINT 0x0E00U
#define LOWEST_MARK_CODE_POINT 0x0300U
#define THAI_BLOCK_END 0x0E7FU
#define LAO_BLOCK_END 0x0EFFU
#define MYANMAR_BLOCK_START 0x1000U
#define MYANMAR_BLOCK_END 0x109FU
#define KHMER_BLOCK_START 0x1780U
#define KHMER_BLOCK_END 0x19FFU
#define SOUTHEAST_ASIAN_BLOCKS_END 0x1A00U
#define HIRAGANA_BLOCK_START 0x3040U
#define HIRAGANA_BLOCK_END 0x309FU
#define COMBINING_VOICED_MARK 0x3099U
#define COMBINING_SEMI_VOICED_MARK 0x309AU
#define KATAKANA_BLOCK_START 0x30A0U
#define KATAKANA_BLOCK_END 0x30FFU
#define HAN_EXTENSION_A_START 0x3400U
#define HAN_EXTENSION_A_END 0x4DBFU
#define HAN_UNIFIED_START 0x4E00U
#define HAN_UNIFIED_END 0x9FFFU
#define HANGUL_SYLLABLE_START 0xAC00U
#define HANGUL_SYLLABLE_END 0xD7A3U
#define HAN_COMPATIBILITY_START 0xF900U
#define HAN_COMPATIBILITY_END 0xFAFFU

int narsil_spans_push(narsil_spans *spans, narsil_span span) {
  if (spans->length >= spans->capacity) {
    size_t capacity = spans->capacity < MIN_SPANS ? MIN_SPANS : spans->capacity;
    while (capacity <= spans->length) {
      if (capacity > (SIZE_MAX / sizeof(narsil_span)) / 2) { return NARSIL_OUT_OF_MEMORY; }
      capacity *= 2;
    }
    narsil_span *grown = core_reallocate(spans->spans, capacity * sizeof(narsil_span));
    if (grown == NULL) { return NARSIL_OUT_OF_MEMORY; }
    spans->spans = grown;
    spans->capacity = capacity;
  }
  spans->spans[spans->length] = span;
  spans->length++;
  return NARSIL_OK;
}

static narsil_span span_of(size_t begin, size_t end) {
  narsil_span span = {(uint32_t)begin, (uint32_t)(end - begin)};
  return span;
}

void narsil_spans_release(narsil_spans *spans) {
  free(spans->spans);
  spans->spans = NULL;
  spans->length = 0;
  spans->capacity = 0;
}

static uint32_t next_split_unit(const narsil_language *language, const uint16_t *units, uint32_t length,
                                size_t *index) {
  if (language->splits_code_points) { return narsil_decode_next(units, length, index); }
  return units[(*index)++];
}

int narsil_split(const narsil_language *language, const uint16_t *units, uint32_t length, narsil_spans *parts) {
  parts->length = 0;
  size_t start = 0;
  size_t index = 0;
  while (index < length) {
    size_t separator = index;
    if (narsil_language_keeps(language, next_split_unit(language, units, length, &index))) { continue; }
    int status = narsil_spans_push(parts, span_of(start, separator));
    if (status != NARSIL_OK) { return status; }
    for (;;) {
      size_t before = index;
      if (index >= length || narsil_language_keeps(language, next_split_unit(language, units, length, &index))) {
        index = before;
        break;
      }
    }
    start = index;
  }
  return narsil_spans_push(parts, span_of(start, length));
}

static int is_mark(uint32_t code_point) {
  if (code_point < LOWEST_MARK_CODE_POINT) { return 0; }
  if (code_point >= HAN_UNIFIED_START && code_point <= HAN_UNIFIED_END) { return 0; }
  if (code_point >= HIRAGANA_BLOCK_START && code_point <= KATAKANA_BLOCK_END) {
    return code_point == COMBINING_VOICED_MARK || code_point == COMBINING_SEMI_VOICED_MARK;
  }
  if (code_point >= HANGUL_SYLLABLE_START && code_point <= HANGUL_SYLLABLE_END) { return 0; }
  if (code_point >= HAN_EXTENSION_A_START && code_point <= HAN_EXTENSION_A_END) { return 0; }
  return (narsil_unicode_properties(code_point) & NARSIL_UNICODE_MARK) != 0;
}

static uint32_t script_in_block(uint32_t code_point, uint32_t block_script) {
  return narsil_unicode_script(code_point) == block_script ? block_script : NARSIL_UNICODE_SCRIPT_OTHER;
}

static uint32_t classify_southeast_asian(uint32_t code_point) {
  if (code_point <= THAI_BLOCK_END) { return script_in_block(code_point, NARSIL_UNICODE_SCRIPT_THAI); }
  if (code_point <= LAO_BLOCK_END) { return script_in_block(code_point, NARSIL_UNICODE_SCRIPT_LAO); }
  if (code_point >= MYANMAR_BLOCK_START && code_point <= MYANMAR_BLOCK_END) {
    return script_in_block(code_point, NARSIL_UNICODE_SCRIPT_MYANMAR);
  }
  if (code_point >= KHMER_BLOCK_START && code_point <= KHMER_BLOCK_END) {
    return script_in_block(code_point, NARSIL_UNICODE_SCRIPT_KHMER);
  }
  return narsil_unicode_script(code_point);
}

static uint32_t prolonged_sound_kind(uint32_t current) {
  return current == NARSIL_UNICODE_SCRIPT_HIRAGANA ? NARSIL_UNICODE_SCRIPT_HIRAGANA : NARSIL_UNICODE_SCRIPT_KATAKANA;
}

static uint32_t classify(uint32_t code_point) {
  if (code_point < LOWEST_NGRAM_CODE_POINT) { return NARSIL_UNICODE_SCRIPT_OTHER; }
  if (code_point < SOUTHEAST_ASIAN_BLOCKS_END) { return classify_southeast_asian(code_point); }
  if (code_point >= HIRAGANA_BLOCK_START && code_point <= HIRAGANA_BLOCK_END) { return NARSIL_UNICODE_SCRIPT_HIRAGANA; }
  if (code_point >= KATAKANA_BLOCK_START && code_point <= KATAKANA_BLOCK_END) { return NARSIL_UNICODE_SCRIPT_KATAKANA; }
  if (code_point >= HAN_UNIFIED_START && code_point <= HAN_UNIFIED_END) { return NARSIL_UNICODE_SCRIPT_HAN; }
  if (code_point >= HAN_EXTENSION_A_START && code_point <= HAN_EXTENSION_A_END) { return NARSIL_UNICODE_SCRIPT_HAN; }
  if (code_point >= HANGUL_SYLLABLE_START && code_point <= HANGUL_SYLLABLE_END) { return NARSIL_UNICODE_SCRIPT_HANGUL; }
  if (code_point >= HAN_COMPATIBILITY_START && code_point <= HAN_COMPATIBILITY_END) {
    return NARSIL_UNICODE_SCRIPT_HAN;
  }
  if (code_point == IDEOGRAPHIC_ITERATION_MARK) { return NARSIL_UNICODE_SCRIPT_HAN; }
  return narsil_unicode_script(code_point);
}

static int emit_run(narsil_span part, const narsil_code_points *offsets, uint32_t kind, uint32_t size,
                    narsil_spans *out) {
  if (offsets->length < 2) { return NARSIL_OK; }
  size_t count = offsets->length - 1;
  const uint32_t *boundaries = offsets->values;
  if (kind == NARSIL_UNICODE_SCRIPT_OTHER || count <= size) {
    return narsil_spans_push(out, span_of((size_t)part.start + boundaries[0], (size_t)part.start + boundaries[count]));
  }
  for (size_t first = 0; first + size <= count; first++) {
    int status = narsil_spans_push(
        out, span_of((size_t)part.start + boundaries[first], (size_t)part.start + boundaries[first + size]));
    if (status != NARSIL_OK) { return status; }
  }
  return NARSIL_OK;
}

int narsil_expand_ngrams(const uint16_t *units, narsil_span part, uint32_t size, narsil_spans *out,
                         narsil_code_points *offsets) {
  const uint16_t *text = units + part.start;
  size_t length = part.length;
  offsets->length = 0;
  if (length == 0) { return NARSIL_OK; }
  uint32_t kind = NARSIL_UNICODE_SCRIPT_OTHER;
  size_t index = 0;
  int status = NARSIL_OK;
  while (index < length && status == NARSIL_OK) {
    size_t start = index;
    uint32_t code_point = narsil_decode_next(text, length, &index);
    if (offsets->length > 0 && is_mark(code_point)) { continue; }
    uint32_t next = code_point == PROLONGED_SOUND_MARK ? prolonged_sound_kind(kind) : classify(code_point);
    if (offsets->length > 0 && next != kind) {
      status = narsil_code_points_push(offsets, (uint32_t)start);
      if (status == NARSIL_OK) { status = emit_run(part, offsets, kind, size, out); }
      offsets->length = 0;
    }
    kind = next;
    if (status == NARSIL_OK) { status = narsil_code_points_push(offsets, (uint32_t)start); }
  }
  if (status == NARSIL_OK) { status = narsil_code_points_push(offsets, (uint32_t)length); }
  if (status == NARSIL_OK) { status = emit_run(part, offsets, kind, size, out); }
  return status;
}
