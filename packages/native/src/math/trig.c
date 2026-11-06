#include "fdlibm.h"
#include "words.h"

#include <math.h>
#include <stdint.h>

#define PI_OVER_FOUR_HIGH_WORD 0x3FE921FB
#define TINY_SINE_HIGH_WORD 0x3E400000
#define TINY_TANGENT_HIGH_WORD 0x3E300000
#define SMALL_COSINE_HIGH_WORD 0x3FD33333
#define LARGE_COSINE_HIGH_WORD 0x3FE90000
#define QUARTER_EXPONENT_STEP 0x00200000
#define TANGENT_REFLECTION_HIGH_WORD 0x3FE59428
#define TANGENT_SIGN_SHIFT 30U
#define TANGENT_SIGN_MASK 2U
#define QUADRANT_MASK 3

static const double half = 5.00000000000000000000e-01;
static const double two = 2.0;
static const double large_cosine_quarter = 0.28125;

static const double cos1 = 4.16666666666666019037e-02;
static const double cos2 = -1.38888888888741095749e-03;
static const double cos3 = 2.48015872894767294178e-05;
static const double cos4 = -2.75573143513906633035e-07;
static const double cos5 = 2.08757232129817482790e-09;
static const double cos6 = -1.13596475577881948265e-11;

static const double sin1 = -1.66666666666666324348e-01;
static const double sin2 = 8.33333333332248946124e-03;
static const double sin3 = -1.98412698298579493134e-04;
static const double sin4 = 2.75573137070700676789e-06;
static const double sin5 = -2.50507602534068634195e-08;
static const double sin6 = 1.58969099521155010221e-10;

static const double tan0 = 3.33333333333334091986e-01;
static const double tan1 = 1.33333333333201242699e-01;
static const double tan2 = 5.39682539762260521377e-02;
static const double tan3 = 2.18694882948595424599e-02;
static const double tan4 = 8.86323982359930005737e-03;
static const double tan5 = 3.59207910759131235356e-03;
static const double tan6 = 1.45620945432529025516e-03;
static const double tan7 = 5.88041240820264096874e-04;
static const double tan8 = 2.46463134818469906812e-04;
static const double tan9 = 7.81794442939557092300e-05;
static const double tan10 = 7.14072491382608190305e-05;
static const double tan11 = -1.85586374855275456654e-05;
static const double tan12 = 2.59073051863633712884e-05;

static const double pio4 = 7.85398163397448278999e-01;
static const double pio4lo = 3.06161699786838301793e-17;

static double kernel_cos(const double *angle) {
  double head = angle[0];
  double tail = angle[1];
  int32_t magnitude = high_word(head) & MAGNITUDE_MASK;
  if (magnitude < TINY_SINE_HIGH_WORD && (int32_t)head == 0) { return 1.0; }
  double square = head * head;
  double poly =
      square * (cos1 + (square * (cos2 + (square * (cos3 + (square * (cos4 + (square * (cos5 + (square * cos6))))))))));
  if (magnitude < SMALL_COSINE_HIGH_WORD) { return 1.0 - ((half * square) - ((square * poly) - (head * tail))); }
  double quarter =
      magnitude > LARGE_COSINE_HIGH_WORD ? large_cosine_quarter : from_words(magnitude - QUARTER_EXPONENT_STEP, 0);
  double shifted = (half * square) - quarter;
  double rest = 1.0 - quarter;
  return rest - (shifted - ((square * poly) - (head * tail)));
}

static double kernel_sin(const double *angle, int with_tail) {
  double head = angle[0];
  double tail = angle[1];
  int32_t magnitude = high_word(head) & MAGNITUDE_MASK;
  if (magnitude < TINY_SINE_HIGH_WORD && (int32_t)head == 0) { return head; }
  double square = head * head;
  double cube = square * head;
  double poly = sin2 + (square * (sin3 + (square * (sin4 + (square * (sin5 + (square * sin6)))))));
  if (with_tail == 0) { return head + (cube * (sin1 + (square * poly))); }
  return head - (((square * ((half * tail) - (cube * poly))) - tail) - (cube * sin1));
}

static double careful_reciprocal(const double *parts) {
  double sum = parts[0] + parts[1];
  double sum_head = with_low_word(sum, 0);
  double sum_tail = parts[1] - (sum_head - parts[0]);
  double reciprocal = -1.0 / sum;
  double reciprocal_head = with_low_word(reciprocal, 0);
  double error = 1.0 + (reciprocal_head * sum_head);
  return reciprocal_head + (reciprocal * (error + (reciprocal_head * sum_tail)));
}

static double tiny_tangent(const double *angle, int sign) {
  double head = angle[0];
  int32_t magnitude = high_word(head) & MAGNITUDE_MASK;
  if ((((uint32_t)magnitude | low_word(head)) | (uint32_t)(sign + 1)) == 0U) { return 1.0 / fabs(head); }
  if (sign == 1) { return head; }
  return careful_reciprocal(angle);
}

static double kernel_tan(const double *angle, int sign) {
  double head = angle[0];
  double tail = angle[1];
  int32_t high = high_word(head);
  int32_t magnitude = high & MAGNITUDE_MASK;
  if (magnitude < TINY_TANGENT_HIGH_WORD && (int32_t)head == 0) { return tiny_tangent(angle, sign); }
  int reflected = magnitude >= TANGENT_REFLECTION_HIGH_WORD;
  if (reflected) {
    if (is_negative_word(high)) {
      head = -head;
      tail = -tail;
    }
    double offset = pio4 - head;
    double offset_tail = pio4lo - tail;
    head = offset + offset_tail;
    tail = 0.0;
  }
  double square = head * head;
  double fourth = square * square;
  double odd = tan1 + (fourth * (tan3 + (fourth * (tan5 + (fourth * (tan7 + (fourth * (tan9 + (fourth * tan11)))))))));
  double even =
      square *
      (tan2 + (fourth * (tan4 + (fourth * (tan6 + (fourth * (tan8 + (fourth * (tan10 + (fourth * tan12))))))))));
  double cube = square * head;
  double rest = tail + (square * ((cube * (odd + even)) + tail));
  rest += tan0 * cube;
  double sum = head + rest;
  if (reflected) {
    double turn = (double)sign;
    double direction = (double)(1 - (int32_t)(((uint32_t)high >> TANGENT_SIGN_SHIFT) & TANGENT_SIGN_MASK));
    return direction * (turn - (two * (head - (((sum * sum) / (sum + turn)) - rest))));
  }
  if (sign == 1) { return sum; }
  double parts[2] = {head, rest};
  return careful_reciprocal(parts);
}

double fdlibm_sin(double value) {
  int32_t magnitude = high_word(value) & MAGNITUDE_MASK;
  if (magnitude <= PI_OVER_FOUR_HIGH_WORD) {
    double angle[2] = {value, 0.0};
    return kernel_sin(angle, 0);
  }
  if (magnitude >= INFINITE_HIGH_WORD) { return (double)NAN; }
  double reduced[2] = {0.0, 0.0};
  int32_t turns = fdlibm_rem_pio2(value, reduced);
  switch (turns & QUADRANT_MASK) {
    case 0:
      return kernel_sin(reduced, 1);
    case 1:
      return kernel_cos(reduced);
    case 2:
      return -kernel_sin(reduced, 1);
    default:
      return -kernel_cos(reduced);
  }
}

double fdlibm_cos(double value) {
  int32_t magnitude = high_word(value) & MAGNITUDE_MASK;
  if (magnitude <= PI_OVER_FOUR_HIGH_WORD) {
    double angle[2] = {value, 0.0};
    return kernel_cos(angle);
  }
  if (magnitude >= INFINITE_HIGH_WORD) { return (double)NAN; }
  double reduced[2] = {0.0, 0.0};
  int32_t turns = fdlibm_rem_pio2(value, reduced);
  switch (turns & QUADRANT_MASK) {
    case 0:
      return kernel_cos(reduced);
    case 1:
      return -kernel_sin(reduced, 1);
    case 2:
      return -kernel_cos(reduced);
    default:
      return kernel_sin(reduced, 1);
  }
}

double fdlibm_tan(double value) {
  int32_t magnitude = high_word(value) & MAGNITUDE_MASK;
  if (magnitude <= PI_OVER_FOUR_HIGH_WORD) {
    double angle[2] = {value, 0.0};
    return kernel_tan(angle, 1);
  }
  if (magnitude >= INFINITE_HIGH_WORD) { return (double)NAN; }
  double reduced[2] = {0.0, 0.0};
  int32_t turns = fdlibm_rem_pio2(value, reduced);
  return kernel_tan(reduced, 1 - ((turns & 1) << 1));
}
