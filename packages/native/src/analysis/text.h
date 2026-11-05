#ifndef NARSIL_ANALYSIS_TEXT_H
#define NARSIL_ANALYSIS_TEXT_H

#include <stddef.h>
#include <stdint.h>

#define NARSIL_HIGH_SURROGATE_FIRST 0xD800U
#define NARSIL_LOW_SURROGATE_FIRST 0xDC00U
#define NARSIL_SURROGATE_END 0xE000U
#define NARSIL_SUPPLEMENTARY_FIRST 0x10000U
#define NARSIL_SURROGATE_PAYLOAD_BITS 10U
#define NARSIL_SURROGATE_PAYLOAD_MASK 0x3FFU
#define NARSIL_ASCII_END 0x80U

typedef struct {
  uint16_t *units;
  size_t length;
  size_t capacity;
} narsil_text;

typedef struct {
  uint32_t *values;
  size_t length;
  size_t capacity;
} narsil_code_points;

int narsil_text_reserve(narsil_text *text, size_t capacity);
int narsil_text_assign(narsil_text *text, const uint16_t *units, size_t length);
int narsil_text_append(narsil_text *text, const uint16_t *units, size_t length);
int narsil_text_push(narsil_text *text, uint16_t unit);
int narsil_text_push_code_point(narsil_text *text, uint32_t code_point);
void narsil_text_release(narsil_text *text);

int narsil_code_points_reserve(narsil_code_points *points, size_t capacity);
int narsil_code_points_push(narsil_code_points *points, uint32_t code_point);
void narsil_code_points_release(narsil_code_points *points);

uint32_t narsil_decode_next(const uint16_t *units, size_t length, size_t *index);
uint32_t narsil_decode_previous(const uint16_t *units, size_t *index);
int narsil_units_are_ascii(const uint16_t *units, size_t length);
int narsil_units_equal(const uint16_t *left, size_t left_length, const uint16_t *right, size_t right_length);

#endif
