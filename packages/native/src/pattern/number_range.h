#ifndef NARSIL_PATTERN_NUMBER_RANGE_H
#define NARSIL_PATTERN_NUMBER_RANGE_H

#include "ast.h"
#include "constants.h"

#include <stdint.h>

typedef struct {
  uint8_t digits[PATTERN_MAX_NUMBER_RANGE_DIGITS];
  uint32_t count;
} pattern_digits;

uint64_t pattern_digits_value(const pattern_digits *digits);
uint32_t pattern_number_range(pattern_ast *tree, const pattern_digits *low, const pattern_digits *high);

#endif
