#include "fdlibm.h"
#include "words.h"

#include <math.h>
#include <stdint.h>

#define ONE_HIGH_WORD 0x3FF00000
#define HALF_HIGH_WORD 0x3FE00000
#define TINY_HIGH_WORD 0x3E400000
#define STEEP_SINE_HIGH_WORD 0x3FEF3333
#define HUGE_TANGENT_HIGH_WORD 0x44100000
#define FIRST_BAND_HIGH_WORD 0x3FDC0000
#define SECOND_BAND_HIGH_WORD 0x3FE60000
#define THIRD_BAND_HIGH_WORD 0x3FF30000
#define FOURTH_BAND_HIGH_WORD 0x40038000
#define NO_BAND (-1)
#define STEEP_BAND 3
#define RATIO_EXPONENT_LIMIT 60
#define RUN_SIGN_SHIFT 30U
#define RUN_SIGN_MASK 2U
#define BOTH_POSITIVE 0U
#define RISE_NEGATIVE 1U
#define RUN_NEGATIVE 2U

static const double huge = 1.000e+300;
static const double two = 2.0;
static const double pio2_hi = 1.57079632679489655800e+00;
static const double pio2_lo = 6.12323399573676603587e-17;
static const double pio4_hi = 7.85398163397448278999e-01;
static const double pS0 = 1.66666666666666657415e-01;
static const double pS1 = -3.25565818622400915405e-01;
static const double pS2 = 2.01212532134862925881e-01;
static const double pS3 = -4.00555345006794114027e-02;
static const double pS4 = 7.91534994289814532176e-04;
static const double pS5 = 3.47933107596021167570e-05;
static const double qS1 = -2.40339491173441421878e+00;
static const double qS2 = 2.02094576023350569471e+00;
static const double qS3 = -6.88283971605453293030e-01;
static const double qS4 = 7.70381505559019352791e-02;

static const double atanhi[] = {
    4.63647609000806093515e-01,
    7.85398163397448278999e-01,
    9.82793723247329054082e-01,
    1.57079632679489655800e+00,
};

static const double atanlo[] = {
    2.26987774529616870924e-17,
    3.06161699786838301793e-17,
    1.39033110312309984516e-17,
    6.12323399573676603587e-17,
};

static const double atan_c0 = 3.33333333333329318027e-01;
static const double atan_c1 = -1.99999999998764832476e-01;
static const double atan_c2 = 1.42857142725034663711e-01;
static const double atan_c3 = -1.11111104054623557880e-01;
static const double atan_c4 = 9.09088713343650656196e-02;
static const double atan_c5 = -7.69187620504482999495e-02;
static const double atan_c6 = 6.66107313738753120669e-02;
static const double atan_c7 = -5.83357013379057348645e-02;
static const double atan_c8 = 4.97687799461593236017e-02;
static const double atan_c9 = -3.65315727442169155270e-02;
static const double atan_c10 = 1.62858201153657823623e-02;

static const double one_and_half = 1.5;
static const double half = 0.5;
static const double tiny = 1.0e-300;
static const double pi_o_4 = 7.8539816339744827900E-01;
static const double pi_o_2 = 1.5707963267948965580E+00;
static const double pi_whole = 3.1415926535897931160E+00;
static const double pi_lo = 1.2246467991473531772E-16;
static const double three = 3.0;

static double asin_ratio(double square) {
  double numerator =
      square * (pS0 + (square * (pS1 + (square * (pS2 + (square * (pS3 + (square * (pS4 + (square * pS5))))))))));
  double denominator = 1.0 + (square * (qS1 + (square * (qS2 + (square * (qS3 + (square * qS4)))))));
  return numerator / denominator;
}

static double steep_asin(double value) {
  int32_t magnitude = high_word(value) & MAGNITUDE_MASK;
  double rest = 1.0 - fabs(value);
  double half_rest = rest * half;
  double root = sqrt(half_rest);
  if (magnitude >= STEEP_SINE_HIGH_WORD) {
    return pio2_hi - ((two * (root + (root * asin_ratio(half_rest)))) - pio2_lo);
  }
  double root_head = with_low_word(root, 0);
  double correction = (half_rest - (root_head * root_head)) / (root + root_head);
  double ratio = asin_ratio(half_rest);
  double low_part = (two * root * ratio) - (pio2_lo - (two * correction));
  double high_part = pio4_hi - (two * root_head);
  return pio4_hi - (low_part - high_part);
}

double fdlibm_asin(double value) {
  int32_t high = high_word(value);
  int32_t magnitude = high & MAGNITUDE_MASK;
  if (magnitude >= ONE_HIGH_WORD) {
    if (((uint32_t)(magnitude - ONE_HIGH_WORD) | low_word(value)) == 0U) {
      return (value * pio2_hi) + (value * pio2_lo);
    }
    return (double)NAN;
  }
  if (magnitude < HALF_HIGH_WORD) {
    double square = 0;
    if (magnitude < TINY_HIGH_WORD) {
      if (huge + value > 1.0) { return value; }
    } else {
      square = value * value;
    }
    return value + (value * asin_ratio(square));
  }
  double angle = steep_asin(value);
  return is_negative_word(high) ? -angle : angle;
}

static int atan_band(double *value, int32_t magnitude) {
  if (magnitude < FIRST_BAND_HIGH_WORD) { return NO_BAND; }
  double absolute = fabs(*value);
  if (magnitude < SECOND_BAND_HIGH_WORD) {
    *value = ((two * absolute) - 1.0) / (two + absolute);
    return 0;
  }
  if (magnitude < THIRD_BAND_HIGH_WORD) {
    *value = (absolute - 1.0) / (absolute + 1.0);
    return 1;
  }
  if (magnitude < FOURTH_BAND_HIGH_WORD) {
    *value = (absolute - one_and_half) / (1.0 + (one_and_half * absolute));
    return 2;
  }
  *value = -1.0 / absolute;
  return STEEP_BAND;
}

double fdlibm_atan(double value) {
  int32_t high = high_word(value);
  int32_t magnitude = high & MAGNITUDE_MASK;
  if (magnitude >= HUGE_TANGENT_HIGH_WORD) {
    if (magnitude > INFINITE_HIGH_WORD || (magnitude == INFINITE_HIGH_WORD && low_word(value) != 0U)) {
      return (double)NAN;
    }
    return is_negative_word(high) ? -atanhi[STEEP_BAND] - atanlo[STEEP_BAND] : atanhi[STEEP_BAND] + atanlo[STEEP_BAND];
  }
  if (magnitude < TINY_HIGH_WORD && huge + value > 1.0) { return value; }
  double reduced = value;
  int band = atan_band(&reduced, magnitude);
  double square = reduced * reduced;
  double fourth = square * square;
  double odd =
      square *
      (atan_c0 +
       (fourth * (atan_c2 + (fourth * (atan_c4 + (fourth * (atan_c6 + (fourth * (atan_c8 + (fourth * atan_c10))))))))));
  double even =
      fourth * (atan_c1 + (fourth * (atan_c3 + (fourth * (atan_c5 + (fourth * (atan_c7 + (fourth * atan_c9))))))));
  if (band < 0) { return reduced - (reduced * (odd + even)); }
  double angle = atanhi[band] - (((reduced * (odd + even)) - atanlo[band]) - reduced);
  return is_negative_word(high) ? -angle : angle;
}

static int is_nan_value(double value) {
  uint32_t low = low_word(value);
  uint32_t magnitude = (uint32_t)(high_word(value) & MAGNITUDE_MASK);
  return (magnitude | ((low | (0U - low)) >> SIGN_BIT)) > (uint32_t)INFINITE_HIGH_WORD;
}

static double both_infinite(uint32_t quadrant) {
  if (quadrant == BOTH_POSITIVE) { return pi_o_4 + tiny; }
  if (quadrant == RISE_NEGATIVE) { return -pi_o_4 - tiny; }
  if (quadrant == RUN_NEGATIVE) { return (three * pi_o_4) + tiny; }
  return (-three * pi_o_4) - tiny;
}

static double run_infinite(uint32_t quadrant) {
  if (quadrant == BOTH_POSITIVE) { return 0.0; }
  if (quadrant == RISE_NEGATIVE) { return -0.0; }
  if (quadrant == RUN_NEGATIVE) { return pi_whole + tiny; }
  return -pi_whole - tiny;
}

typedef struct {
  double rise;
  double run;
  uint32_t quadrant;
} slope;

static double place_in_quadrant(const slope *line, double angle) {
  if (line->quadrant == BOTH_POSITIVE) { return angle; }
  if (line->quadrant == RISE_NEGATIVE) { return -angle; }
  if (line->quadrant == RUN_NEGATIVE) { return pi_whole - (angle - pi_lo); }
  return (angle - pi_lo) - pi_whole;
}

static double edge_angle(const slope *line, int *found) {
  uint32_t quadrant = line->quadrant;
  int32_t run_high = high_word(line->run);
  uint32_t run_low = low_word(line->run);
  int32_t run_magnitude = run_high & MAGNITUDE_MASK;
  int32_t rise_high = high_word(line->rise);
  int32_t rise_magnitude = rise_high & MAGNITUDE_MASK;
  *found = 1;
  if (((uint32_t)rise_magnitude | low_word(line->rise)) == 0U) {
    if (quadrant == BOTH_POSITIVE || quadrant == RISE_NEGATIVE) { return line->rise; }
    return quadrant == RUN_NEGATIVE ? pi_whole + tiny : -pi_whole - tiny;
  }
  if (((uint32_t)run_magnitude | run_low) == 0U) {
    return is_negative_word(rise_high) ? -pi_o_2 - tiny : pi_o_2 + tiny;
  }
  if (run_magnitude == INFINITE_HIGH_WORD) {
    return rise_magnitude == INFINITE_HIGH_WORD ? both_infinite(quadrant) : run_infinite(quadrant);
  }
  if (rise_magnitude == INFINITE_HIGH_WORD) { return is_negative_word(rise_high) ? -pi_o_2 - tiny : pi_o_2 + tiny; }
  *found = 0;
  return 0.0;
}

double fdlibm_atan2(double rise, double run) {
  if (is_nan_value(rise) || is_nan_value(run)) { return (double)NAN; }
  int32_t run_high = high_word(run);
  if ((((uint32_t)run_high - (uint32_t)ONE_HIGH_WORD) | low_word(run)) == 0U) { return fdlibm_atan(rise); }
  int32_t rise_high = high_word(rise);
  slope line = {rise, run,
                (((uint32_t)rise_high >> SIGN_BIT) & 1U) | (((uint32_t)run_high >> RUN_SIGN_SHIFT) & RUN_SIGN_MASK)};
  int found = 0;
  double edge = edge_angle(&line, &found);
  if (found) { return edge; }
  int32_t exponent_gap = floor_shift((rise_high & MAGNITUDE_MASK) - (run_high & MAGNITUDE_MASK), EXPONENT_SHIFT);
  double angle = 0.0;
  if (exponent_gap > RATIO_EXPONENT_LIMIT) {
    angle = pi_o_2 + (half * pi_lo);
    line.quadrant &= 1U;
  } else if (is_negative_word(run_high) && exponent_gap < -RATIO_EXPONENT_LIMIT) {
    angle = 0.0;
  } else {
    angle = fdlibm_atan(fabs(rise / run));
  }
  return place_in_quadrant(&line, angle);
}
