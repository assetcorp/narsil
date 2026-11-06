#include "fdlibm.h"
#include "words.h"

#include <math.h>
#include <stdint.h>

#define CHUNK_BITS 24
#define CHUNK_TOP_BIT 23
#define CHUNK_LIMIT 0x1000000
#define CHUNK_MASK 0xFFFFFF
#define CHUNK_SLOTS 20
#define EXTENDED_TERMS 4
#define EXPONENT_BIAS_LESS_23 1046
#define INPUT_CHUNKS 3
#define INTEGRAL_INPUT_CHUNKS 2
#define OCTANT_MASK 7
#define PAST_HALF_TURN 2
#define TOP_CHUNK_MASK_ONE 0x7FFFFF
#define TOP_CHUNK_MASK_TWO 0x3FFFFF
#define TABLED_MULTIPLES 32
#define PI_OVER_FOUR_HIGH_WORD 0x3FE921FB
#define PI_OVER_TWO_HIGH_WORD 0x3FF921FB
#define THREE_PI_OVER_FOUR_HIGH_WORD 0x4002D97C
#define MEDIUM_LIMIT_HIGH_WORD 0x413921FB
#define SECOND_ROUND_CANCELLED_BITS 16
#define THIRD_ROUND_CANCELLED_BITS 49

static const int32_t two_over_pi[] = {
    0xA2F983, 0x6E4E44, 0x1529FC, 0x2757D1, 0xF534DD, 0xC0DB62, 0x95993C, 0x439041, 0xFE5163, 0xABDEBB, 0xC561B7,
    0x246E3A, 0x424DD2, 0xE00649, 0x2EEA09, 0xD1921C, 0xFE1DEB, 0x1CB129, 0xA73EE8, 0x8235F5, 0x2EBB44, 0x84E99C,
    0x7026B4, 0x5F7E41, 0x3991D6, 0x398353, 0x39F49C, 0x845F8B, 0xBDF928, 0x3B1FF8, 0x97FFDE, 0x05980F, 0xEF2F11,
    0x8B5A0A, 0x6D1F6D, 0x367ECF, 0x27CB09, 0xB74F46, 0x3F669E, 0x5FEA2D, 0x7527BA, 0xC7EBE5, 0xF17B3D, 0x0739F7,
    0x8A5292, 0xEA6BFB, 0x5FB11F, 0x8D5D08, 0x560330, 0x46FC7B, 0x6BABF0, 0xCFBC20, 0x9AF436, 0x1DA9E3, 0x91615E,
    0xE61B08, 0x659985, 0x5F14A0, 0x68408D, 0xFFD880, 0x4D7327, 0x310606, 0x1556CA, 0x73A8C9, 0x60E27B, 0xC08C6B,
};

static const int32_t multiple_high_words[TABLED_MULTIPLES] = {
    0x3FF921FB, 0x400921FB, 0x4012D97C, 0x401921FB, 0x401F6A7A, 0x4022D97C, 0x4025FDBB, 0x402921FB,
    0x402C463A, 0x402F6A7A, 0x4031475C, 0x4032D97C, 0x40346B9C, 0x4035FDBB, 0x40378FDB, 0x403921FB,
    0x403AB41B, 0x403C463A, 0x403DD85A, 0x403F6A7A, 0x40407E4C, 0x4041475C, 0x4042106C, 0x4042D97C,
    0x4043A28C, 0x40446B9C, 0x404534AC, 0x4045FDBB, 0x4046C6CB, 0x40478FDB, 0x404858EB, 0x404921FB,
};

static const double pi_over_two_chunks[] = {
    1.57079625129699707031e+00, 7.54978941586159635335e-08, 5.39030252995776476554e-15, 3.28200341580791294123e-22,
    1.27065575308067607349e-29, 1.22933308981111328932e-36, 2.73370053816464559624e-44, 2.16741683877804819444e-51,
};

static const double two24 = 1.67772160000000000000e+07;
static const double twon24 = 5.96046447753906250000e-08;
static const double one_eighth = 0.125;
static const double eight = 8.0;
static const double half = 5.00000000000000000000e-01;
static const double invpio2 = 6.36619772367581382433e-01;
static const double pio2_1 = 1.57079632673412561417e+00;
static const double pio2_1t = 6.07710050650619224932e-11;
static const double pio2_2 = 6.07710050630396597660e-11;
static const double pio2_2t = 2.02226624879595063154e-21;
static const double pio2_3 = 2.02226624871116645580e-21;
static const double pio2_3t = 8.47842766036889956997e-32;

typedef struct {
  const double *input;
  int32_t last_input;
  int32_t table_start;
  int32_t exponent;
  int32_t top;
  int32_t quotient;
  int32_t past_half;
  double fraction;
  int32_t chunks[CHUNK_SLOTS];
  double factors[CHUNK_SLOTS];
  double terms[CHUNK_SLOTS];
  double products[CHUNK_SLOTS];
} reduction;

static double product_term(const reduction *red, int32_t index) {
  double sum = 0.0;
  for (int32_t j = 0; j <= red->last_input; j++) { sum += red->input[j] * red->factors[red->last_input + index - j]; }
  return sum;
}

static void distill(reduction *red) {
  double rest = red->products[red->top];
  for (int32_t i = 0, j = red->top; j > 0; i++, j--) {
    double carried = (double)(int32_t)(twon24 * rest);
    red->chunks[i] = (int32_t)(rest - (two24 * carried));
    rest = red->products[j - 1] + carried;
  }
  red->fraction = rest;
}

static void split_quotient(reduction *red) {
  double scaled = scalbn(red->fraction, red->exponent);
  scaled -= eight * floor(scaled * one_eighth);
  red->quotient = (int32_t)scaled;
  scaled -= (double)red->quotient;
  red->past_half = 0;
  int32_t highest = red->top - 1;
  if (highest >= 0 && red->exponent > 0) {
    int32_t whole = red->chunks[highest] >> (CHUNK_BITS - red->exponent);
    red->quotient += whole;
    red->chunks[highest] -= whole << (CHUNK_BITS - red->exponent);
    red->past_half = red->chunks[highest] >> (CHUNK_TOP_BIT - red->exponent);
  } else if (highest >= 0 && red->exponent == 0) {
    red->past_half = red->chunks[highest] >> CHUNK_TOP_BIT;
  } else if (scaled >= half) {
    red->past_half = PAST_HALF_TURN;
  }
  red->fraction = scaled;
}

static void complement(reduction *red) {
  if (red->past_half <= 0) { return; }
  int32_t carry = 0;
  red->quotient += 1;
  for (int32_t i = 0; i < red->top; i++) {
    int32_t chunk = red->chunks[i];
    if (carry == 0) {
      if (chunk != 0) {
        carry = 1;
        red->chunks[i] = CHUNK_LIMIT - chunk;
      }
    } else {
      red->chunks[i] = CHUNK_MASK - chunk;
    }
  }
  int32_t highest = red->top - 1;
  if (highest >= 0 && highest < CHUNK_SLOTS) {
    if (red->exponent == 1) { red->chunks[highest] &= TOP_CHUNK_MASK_ONE; }
    if (red->exponent == 2) { red->chunks[highest] &= TOP_CHUNK_MASK_TWO; }
  }
  if (red->past_half == PAST_HALF_TURN) {
    red->fraction = 1.0 - red->fraction;
    if (carry != 0) { red->fraction -= scalbn(1.0, red->exponent); }
  }
}

static int32_t more_terms_needed(const reduction *red) {
  if (red->fraction != 0.0) { return 0; }
  int32_t bits = 0;
  for (int32_t i = red->top - 1; i >= EXTENDED_TERMS; i--) { bits |= red->chunks[i]; }
  if (bits != 0) { return 0; }
  int32_t count = 1;
  while (EXTENDED_TERMS >= count && red->chunks[EXTENDED_TERMS - count] == 0) { count++; }
  return count;
}

static void extend(reduction *red, int32_t count) {
  for (int32_t i = red->top + 1; i <= red->top + count; i++) {
    red->factors[red->last_input + i] = (double)two_over_pi[red->table_start + i];
    red->products[i] = product_term(red, i);
  }
  red->top += count;
}

static void normalise_chunks(reduction *red) {
  if (red->fraction == 0.0) {
    red->top -= 1;
    red->exponent -= CHUNK_BITS;
    while (red->top > 0 && red->chunks[red->top] == 0) {
      red->top--;
      red->exponent -= CHUNK_BITS;
    }
    return;
  }
  double scaled = scalbn(red->fraction, -red->exponent);
  if (scaled >= two24) {
    double carried = (double)(int32_t)(twon24 * scaled);
    red->chunks[red->top] = (int32_t)(scaled - (two24 * carried));
    red->top += 1;
    red->exponent += CHUNK_BITS;
    red->chunks[red->top] = (int32_t)carried;
  } else {
    red->chunks[red->top] = (int32_t)scaled;
  }
}

static void write_result(reduction *red, double *out) {
  double scale = scalbn(1.0, red->exponent);
  for (int32_t i = red->top; i >= 0; i--) {
    red->products[i] = scale * (double)red->chunks[i];
    scale *= twon24;
  }
  for (int32_t i = red->top; i >= 0; i--) {
    double sum = 0.0;
    for (int32_t k = 0; k <= EXTENDED_TERMS && k <= red->top - i; k++) {
      sum += pi_over_two_chunks[k] * red->products[i + k];
    }
    red->terms[red->top - i] = sum;
  }
  double sum = 0.0;
  for (int32_t i = red->top; i >= 0; i--) { sum += red->terms[i]; }
  out[0] = red->past_half == 0 ? sum : -sum;
  sum = red->terms[0] - sum;
  for (int32_t i = 1; i <= red->top; i++) { sum += red->terms[i]; }
  out[1] = red->past_half == 0 ? sum : -sum;
}

static int32_t kernel_rem_pio2(const double *input, int32_t count, double *out, int32_t exponent) {
  reduction red = {0};
  red.input = input;
  red.last_input = count - 1;
  red.table_start = (exponent - 3) / CHUNK_BITS;
  if (red.table_start < 0) { red.table_start = 0; }
  red.exponent = exponent - (CHUNK_BITS * (red.table_start + 1));
  for (int32_t i = 0, j = red.table_start - red.last_input; i <= red.last_input + EXTENDED_TERMS; i++, j++) {
    red.factors[i] = j < 0 ? 0.0 : (double)two_over_pi[j];
  }
  for (int32_t i = 0; i <= EXTENDED_TERMS; i++) { red.products[i] = product_term(&red, i); }
  red.top = EXTENDED_TERMS;
  for (;;) {
    distill(&red);
    split_quotient(&red);
    complement(&red);
    int32_t needed = more_terms_needed(&red);
    if (needed == 0) { break; }
    extend(&red, needed);
  }
  normalise_chunks(&red);
  write_result(&red, out);
  return red.quotient & OCTANT_MASK;
}

static int32_t near_quarter_turn(double value, double *out) {
  int32_t magnitude = high_word(value) & MAGNITUDE_MASK;
  if (!is_negative_word(high_word(value))) {
    double rest = value - pio2_1;
    if (magnitude != PI_OVER_TWO_HIGH_WORD) {
      out[0] = rest - pio2_1t;
      out[1] = (rest - out[0]) - pio2_1t;
    } else {
      rest -= pio2_2;
      out[0] = rest - pio2_2t;
      out[1] = (rest - out[0]) - pio2_2t;
    }
    return 1;
  }
  double rest = value + pio2_1;
  if (magnitude != PI_OVER_TWO_HIGH_WORD) {
    out[0] = rest + pio2_1t;
    out[1] = (rest - out[0]) + pio2_1t;
  } else {
    rest += pio2_2;
    out[0] = rest + pio2_2t;
    out[1] = (rest - out[0]) + pio2_2t;
  }
  return -1;
}

static int32_t cancelled_bits(int32_t exponent, double reduced) {
  return exponent - (int32_t)(((uint32_t)high_word(reduced) >> EXPONENT_SHIFT) & EXPONENT_MASK);
}

static int32_t medium_turns(double value, double *out) {
  int32_t magnitude = high_word(value) & MAGNITUDE_MASK;
  double absolute = fabs(value);
  int32_t turns = (int32_t)((absolute * invpio2) + half);
  double whole = (double)turns;
  double rest = absolute - (whole * pio2_1);
  double tail = whole * pio2_1t;
  out[0] = rest - tail;
  if (turns >= TABLED_MULTIPLES || magnitude == multiple_high_words[turns - 1]) {
    int32_t exponent = magnitude >> EXPONENT_SHIFT;
    if (cancelled_bits(exponent, out[0]) > SECOND_ROUND_CANCELLED_BITS) {
      double before = rest;
      tail = whole * pio2_2;
      rest = before - tail;
      tail = (whole * pio2_2t) - ((before - rest) - tail);
      out[0] = rest - tail;
      if (cancelled_bits(exponent, out[0]) > THIRD_ROUND_CANCELLED_BITS) {
        before = rest;
        tail = whole * pio2_3;
        rest = before - tail;
        tail = (whole * pio2_3t) - ((before - rest) - tail);
        out[0] = rest - tail;
      }
    }
  }
  out[1] = (rest - out[0]) - tail;
  if (is_negative_word(high_word(value))) {
    out[0] = -out[0];
    out[1] = -out[1];
    return -turns;
  }
  return turns;
}

static int32_t large_turns(double value, double *out) {
  int32_t magnitude = high_word(value) & MAGNITUDE_MASK;
  int32_t exponent = (magnitude >> EXPONENT_SHIFT) - EXPONENT_BIAS_LESS_23;
  double scaled = from_words(magnitude - (int32_t)((uint32_t)exponent << EXPONENT_SHIFT), low_word(value));
  double chunks[INPUT_CHUNKS];
  for (int32_t i = 0; i < INTEGRAL_INPUT_CHUNKS; i++) {
    chunks[i] = (double)(int32_t)scaled;
    scaled = (scaled - chunks[i]) * two24;
  }
  chunks[INTEGRAL_INPUT_CHUNKS] = scaled;
  int32_t count = INPUT_CHUNKS;
  while (count > 1 && chunks[count - 1] == 0.0) { count--; }
  int32_t turns = kernel_rem_pio2(chunks, count, out, exponent);
  if (is_negative_word(high_word(value))) {
    out[0] = -out[0];
    out[1] = -out[1];
    return -turns;
  }
  return turns;
}

int32_t fdlibm_rem_pio2(double value, double *out) {
  int32_t magnitude = high_word(value) & MAGNITUDE_MASK;
  if (magnitude <= PI_OVER_FOUR_HIGH_WORD) {
    out[0] = value;
    out[1] = 0;
    return 0;
  }
  if (magnitude < THREE_PI_OVER_FOUR_HIGH_WORD) { return near_quarter_turn(value, out); }
  if (magnitude <= MEDIUM_LIMIT_HIGH_WORD) { return medium_turns(value, out); }
  if (magnitude >= INFINITE_HIGH_WORD) {
    out[0] = (double)NAN;
    out[1] = out[0];
    return 0;
  }
  return large_turns(value, out);
}
