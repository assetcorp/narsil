#ifndef NARSIL_MATH_WORDS_H
#define NARSIL_MATH_WORDS_H

#include <stdint.h>
#include <string.h>

#define WORD_BITS 32U
#define SIGN_BIT 31U
#define MAGNITUDE_MASK 0x7FFFFFFF
#define EXPONENT_SHIFT 20U
#define EXPONENT_MASK 0x7FFU
#define INFINITE_HIGH_WORD 0x7FF00000
#define SMALLEST_NORMAL_HIGH_WORD 0x00100000

static inline uint64_t bits_of(double value) {
  uint64_t bits = 0;
  memcpy(&bits, &value, sizeof bits);
  return bits;
}

static inline double double_of(uint64_t bits) {
  double value = 0;
  memcpy(&value, &bits, sizeof value);
  return value;
}

static inline int32_t high_word(double value) { return (int32_t)(uint32_t)(bits_of(value) >> WORD_BITS); }

static inline uint32_t low_word(double value) { return (uint32_t)bits_of(value); }

static inline double from_words(int32_t high, uint32_t low) {
  return double_of(((uint64_t)(uint32_t)high << WORD_BITS) | low);
}

static inline double with_high_word(double value, int32_t high) { return from_words(high, low_word(value)); }

static inline double with_low_word(double value, uint32_t low) { return from_words(high_word(value), low); }

static inline int32_t floor_shift(int32_t value, uint32_t shift) {
  return value >= 0 ? value >> shift : -1 - ((-1 - value) >> shift);
}

static inline int is_negative_word(int32_t high) { return (((uint32_t)high >> SIGN_BIT) & 1U) != 0; }

#endif
