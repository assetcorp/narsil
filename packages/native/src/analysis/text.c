#include "text.h"

#include "../../include/narsil_core.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define MIN_CAPACITY 16U

typedef struct {
  size_t current;
  size_t needed;
  size_t element_size;
} growth;

static size_t grown_capacity(growth request) {
  size_t limit = SIZE_MAX / request.element_size;
  size_t capacity = request.current < MIN_CAPACITY ? MIN_CAPACITY : request.current;
  while (capacity < request.needed) {
    if (capacity > limit / 2) { return request.needed <= limit ? request.needed : 0; }
    capacity *= 2;
  }
  return capacity;
}

int narsil_text_reserve(narsil_text *text, size_t capacity) {
  if (capacity <= text->capacity) { return NARSIL_OK; }
  growth request = {text->capacity, capacity, sizeof(uint16_t)};
  size_t grown = grown_capacity(request);
  if (grown == 0) { return NARSIL_OUT_OF_MEMORY; }
  uint16_t *units = realloc(text->units, grown * sizeof(uint16_t));
  if (units == NULL) { return NARSIL_OUT_OF_MEMORY; }
  text->units = units;
  text->capacity = grown;
  return NARSIL_OK;
}

int narsil_text_assign(narsil_text *text, const uint16_t *units, size_t length) {
  text->length = 0;
  return narsil_text_append(text, units, length);
}

int narsil_text_append(narsil_text *text, const uint16_t *units, size_t length) {
  if (length == 0) { return NARSIL_OK; }
  if (length > SIZE_MAX - text->length) { return NARSIL_OUT_OF_MEMORY; }
  int status = narsil_text_reserve(text, text->length + length);
  if (status != NARSIL_OK) { return status; }
  memmove(text->units + text->length, units, length * sizeof(uint16_t));
  text->length += length;
  return NARSIL_OK;
}

int narsil_text_push(narsil_text *text, uint16_t unit) {
  if (text->length == text->capacity) {
    int status = narsil_text_reserve(text, text->length + 1);
    if (status != NARSIL_OK) { return status; }
  }
  text->units[text->length++] = unit;
  return NARSIL_OK;
}

int narsil_text_push_code_point(narsil_text *text, uint32_t code_point) {
  if (code_point < NARSIL_SUPPLEMENTARY_FIRST) { return narsil_text_push(text, (uint16_t)code_point); }
  uint32_t offset = code_point - NARSIL_SUPPLEMENTARY_FIRST;
  int status =
      narsil_text_push(text, (uint16_t)(NARSIL_HIGH_SURROGATE_FIRST + (offset >> NARSIL_SURROGATE_PAYLOAD_BITS)));
  if (status != NARSIL_OK) { return status; }
  return narsil_text_push(text, (uint16_t)(NARSIL_LOW_SURROGATE_FIRST + (offset & NARSIL_SURROGATE_PAYLOAD_MASK)));
}

void narsil_text_release(narsil_text *text) {
  free(text->units);
  text->units = NULL;
  text->length = 0;
  text->capacity = 0;
}

int narsil_code_points_reserve(narsil_code_points *points, size_t capacity) {
  if (capacity <= points->capacity) { return NARSIL_OK; }
  growth request = {points->capacity, capacity, sizeof(uint32_t)};
  size_t grown = grown_capacity(request);
  if (grown == 0) { return NARSIL_OUT_OF_MEMORY; }
  uint32_t *values = realloc(points->values, grown * sizeof(uint32_t));
  if (values == NULL) { return NARSIL_OUT_OF_MEMORY; }
  points->values = values;
  points->capacity = grown;
  return NARSIL_OK;
}

int narsil_code_points_push(narsil_code_points *points, uint32_t code_point) {
  if (points->length == points->capacity) {
    int status = narsil_code_points_reserve(points, points->length + 1);
    if (status != NARSIL_OK) { return status; }
  }
  points->values[points->length++] = code_point;
  return NARSIL_OK;
}

void narsil_code_points_release(narsil_code_points *points) {
  free(points->values);
  points->values = NULL;
  points->length = 0;
  points->capacity = 0;
}

static int is_high_surrogate(uint32_t unit) {
  return unit >= NARSIL_HIGH_SURROGATE_FIRST && unit < NARSIL_LOW_SURROGATE_FIRST;
}

static int is_low_surrogate(uint32_t unit) { return unit >= NARSIL_LOW_SURROGATE_FIRST && unit < NARSIL_SURROGATE_END; }

static uint32_t combine_surrogates(uint32_t high, uint32_t low) {
  return NARSIL_SUPPLEMENTARY_FIRST + ((high - NARSIL_HIGH_SURROGATE_FIRST) << NARSIL_SURROGATE_PAYLOAD_BITS) +
         (low - NARSIL_LOW_SURROGATE_FIRST);
}

uint32_t narsil_decode_next(const uint16_t *units, size_t length, size_t *index) {
  uint32_t unit = units[*index];
  *index += 1;
  if (is_high_surrogate(unit) && *index < length && is_low_surrogate(units[*index])) {
    uint32_t low = units[*index];
    *index += 1;
    return combine_surrogates(unit, low);
  }
  return unit;
}

uint32_t narsil_decode_previous(const uint16_t *units, size_t *index) {
  *index -= 1;
  uint32_t unit = units[*index];
  if (is_low_surrogate(unit) && *index > 0 && is_high_surrogate(units[*index - 1])) {
    *index -= 1;
    return combine_surrogates(units[*index], unit);
  }
  return unit;
}

int narsil_units_are_ascii(const uint16_t *units, size_t length) {
  for (size_t i = 0; i < length; i++) {
    if (units[i] >= NARSIL_ASCII_END) { return 0; }
  }
  return 1;
}

int narsil_units_equal(const uint16_t *left, size_t left_length, const uint16_t *right, size_t right_length) {
  return left_length == right_length && (left_length == 0 || memcmp(left, right, left_length * sizeof(uint16_t)) == 0);
}

void narsil_replace_unpaired_surrogates(uint16_t *units, size_t length) {
  for (size_t i = 0; i < length; i++) {
    uint32_t unit = units[i];
    if (unit < NARSIL_HIGH_SURROGATE_FIRST || unit >= NARSIL_SURROGATE_END) { continue; }
    if (is_high_surrogate(unit) && i + 1 < length && is_low_surrogate(units[i + 1])) {
      i++;
      continue;
    }
    units[i] = (uint16_t)NARSIL_REPLACEMENT_CHARACTER;
  }
}
