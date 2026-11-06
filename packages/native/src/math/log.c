#include "fdlibm.h"
#include "words.h"

#include <math.h>
#include <stdint.h>

#define EXPONENT_BIAS 1023
#define SUBNORMAL_SCALE_EXPONENT 54
#define ROUNDING_OFFSET 0x95F64
#define HALVING_BIT 0x100000
#define ONE_HIGH_WORD 0x3FF00000
#define SIGNIFICAND_MASK 0x000FFFFF
#define NEAR_ONE_LIMIT 3
#define LOWER_SPLIT 0x6147A
#define UPPER_SPLIT 0x6B851

static const double ln2_hi = 6.93147180369123816490e-01;
static const double ln2_lo = 1.90821492927058770002e-10;
static const double two54 = 1.80143985094819840000e+16;
static const double two = 2.0;
static const double third = 0.33333333333333333;
static const double half = 0.5;
static const double lg1 = 6.666666666666735130e-01;
static const double lg2 = 3.999999999940941908e-01;
static const double lg3 = 2.857142874366239149e-01;
static const double lg4 = 2.222219843214978396e-01;
static const double lg5 = 1.818357216161805012e-01;
static const double lg6 = 1.531383769920937332e-01;
static const double lg7 = 1.479819860511658591e-01;

typedef struct {
  double fraction;
  int32_t scale;
  int32_t significand;
} log_parts;

static double near_one(const log_parts *parts) {
  double fraction = parts->fraction;
  if (fraction == 0.0) {
    if (parts->scale == 0) { return 0.0; }
    double scale = (double)parts->scale;
    return (scale * ln2_hi) + (scale * ln2_lo);
  }
  double cubic = fraction * fraction * (half - (third * fraction));
  if (parts->scale == 0) { return fraction - cubic; }
  double scale = (double)parts->scale;
  return (scale * ln2_hi) - ((cubic - (scale * ln2_lo)) - fraction);
}

static double series(const log_parts *parts) {
  double fraction = parts->fraction;
  double ratio = fraction / (two + fraction);
  double scale = (double)parts->scale;
  double square = ratio * ratio;
  int32_t below = parts->significand - LOWER_SPLIT;
  double fourth = square * square;
  int32_t above = UPPER_SPLIT - parts->significand;
  double even = fourth * (lg2 + (fourth * (lg4 + (fourth * lg6))));
  double odd = square * (lg1 + (fourth * (lg3 + (fourth * (lg5 + (fourth * lg7))))));
  double poly = odd + even;
  if ((below | above) > 0) {
    double half_square = half * fraction * fraction;
    if (parts->scale == 0) { return fraction - (half_square - (ratio * (half_square + poly))); }
    return (scale * ln2_hi) - ((half_square - ((ratio * (half_square + poly)) + (scale * ln2_lo))) - fraction);
  }
  if (parts->scale == 0) { return fraction - (ratio * (fraction - poly)); }
  return (scale * ln2_hi) - (((ratio * (fraction - poly)) - (scale * ln2_lo)) - fraction);
}

double fdlibm_log(double value) {
  int32_t high = high_word(value);
  int32_t scale = 0;
  double scaled = value;
  if (high < SMALLEST_NORMAL_HIGH_WORD) {
    if (((uint32_t)(high & MAGNITUDE_MASK) | low_word(value)) == 0U) { return -HUGE_VAL; }
    if (high < 0) { return (double)NAN; }
    scale -= SUBNORMAL_SCALE_EXPONENT;
    scaled *= two54;
    high = high_word(scaled);
  }
  if (high >= INFINITE_HIGH_WORD) { return scaled + scaled; }
  scale += (high >> EXPONENT_SHIFT) - EXPONENT_BIAS;
  int32_t significand = high & SIGNIFICAND_MASK;
  int32_t halving = (significand + ROUNDING_OFFSET) & HALVING_BIT;
  scaled = with_high_word(scaled, significand | (halving ^ ONE_HIGH_WORD));
  scale += halving >> EXPONENT_SHIFT;
  log_parts parts = {scaled - 1.0, scale, significand};
  if ((SIGNIFICAND_MASK & (2 + significand)) < NEAR_ONE_LIMIT) { return near_one(&parts); }
  return series(&parts);
}
