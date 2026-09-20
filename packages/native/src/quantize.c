#include "internal.h"

#include "../include/narsil_core.h"

#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#define OSQ_LAMBDA 0.1
#define OSQ_REFINE_ROUNDS 5
#define OSQ_REFINE_TOLERANCE 1e-8
#define OSQ_GRID_ONE_BIT 0.798
#define OSQ_GRID_TWO_BITS 1.493
#define OSQ_GRID_FOUR_BITS 2.514
#define OSQ_GRID_EIGHT_BITS 3.922
#define NARROW_CODE_QUERY_BITS 4
#define ROUND_HALF_UP 0.5

typedef struct {
  const double *centred;
  uint32_t dimension;
  double steps;
  double norm;
} refinement;

typedef struct {
  double correction;
  double total;
  double minimum;
  double maximum;
} centred_summary;

uint32_t code_bytes_of(uint32_t dimension, uint32_t bits) {
  return ((dimension * bits) + (BITS_PER_BYTE - 1)) / BITS_PER_BYTE;
}

uint32_t narsil_record_bytes(uint32_t dimension, uint32_t bits) {
  if (bits == 0) { return 0; }
  return code_bytes_of(dimension, bits) + NARSIL_OSQ_TRAILER_BYTES;
}

uint32_t query_bits_of(uint32_t bits) { return bits == BITS_PER_BYTE ? BITS_PER_BYTE : NARROW_CODE_QUERY_BITS; }

static double steps_of(uint32_t bits) { return (double)((1U << bits) - 1); }

static double grid_of(uint32_t bits) {
  switch (bits) {
    case 1:
      return OSQ_GRID_ONE_BIT;
    case 2:
      return OSQ_GRID_TWO_BITS;
    case 4:
      return OSQ_GRID_FOUR_BITS;
    default:
      return OSQ_GRID_EIGHT_BITS;
  }
}

static double clamp(double value, level_range range) {
  double raised = value > range.lower ? value : range.lower;
  return raised < range.upper ? raised : range.upper;
}

static double level_of(double value, level_range range, double steps) {
  if (range.upper == range.lower) { return 0; }
  return floor((((clamp(value, range) - range.lower) * steps) / (range.upper - range.lower)) + ROUND_HALF_UP);
}

static double loss_of(const refinement *problem, level_range range) {
  const double *centred = problem->centred;
  double projected_error = 0;
  double squared_error = 0;
  double width = (range.upper - range.lower) / problem->steps;
  for (uint32_t i = 0; i < problem->dimension; i++) {
    double reconstructed = range.lower + (width * level_of(centred[i], range, problem->steps));
    projected_error += centred[i] * (centred[i] - reconstructed);
    squared_error += (centred[i] - reconstructed) * (centred[i] - reconstructed);
  }
  return (((1 - OSQ_LAMBDA) * projected_error * projected_error) / problem->norm) + (OSQ_LAMBDA * squared_error);
}

static level_range refine(refinement problem, level_range start) {
  level_range range = start;
  const double *centred = problem.centred;
  for (uint32_t i = 0; i < problem.dimension; i++) { problem.norm += centred[i] * centred[i]; }
  if (problem.norm == 0 || range.upper == range.lower) { return range; }
  double best = loss_of(&problem, range);
  for (int round = 0; round < OSQ_REFINE_ROUNDS; round++) {
    double daa = 0;
    double dab = 0;
    double dbb = 0;
    double dax = 0;
    double dbx = 0;
    for (uint32_t i = 0; i < problem.dimension; i++) {
      double fraction = level_of(centred[i], range, problem.steps) / problem.steps;
      daa += (1 - fraction) * (1 - fraction);
      dab += (1 - fraction) * fraction;
      dbb += fraction * fraction;
      dax += centred[i] * (1 - fraction);
      dbx += centred[i] * fraction;
    }
    double gram_aa = (((1 - OSQ_LAMBDA) * dax * dax) / problem.norm) + (OSQ_LAMBDA * daa);
    double gram_ab = (((1 - OSQ_LAMBDA) * dax * dbx) / problem.norm) + (OSQ_LAMBDA * dab);
    double gram_bb = (((1 - OSQ_LAMBDA) * dbx * dbx) / problem.norm) + (OSQ_LAMBDA * dbb);
    double determinant = (gram_aa * gram_bb) - (gram_ab * gram_ab);
    if (determinant == 0) { break; }
    level_range next = {((gram_bb * dax) - (gram_ab * dbx)) / determinant,
                        ((gram_aa * dbx) - (gram_ab * dax)) / determinant};
    if (fabs(next.lower - range.lower) < OSQ_REFINE_TOLERANCE &&
        fabs(next.upper - range.upper) < OSQ_REFINE_TOLERANCE) {
      break;
    }
    double candidate = loss_of(&problem, next);
    if (candidate > best) { break; }
    range = next;
    best = candidate;
  }
  return range;
}

static void normalise_into(double *normalised, const float *vector, uint32_t dimension) {
  double squares = 0;
  for (uint32_t i = 0; i < dimension; i++) { squares += (double)vector[i] * (double)vector[i]; }
  double length = sqrt(squares);
  for (uint32_t i = 0; i < dimension; i++) {
    normalised[i] = length == 0 ? (double)vector[i] : (double)vector[i] / length;
  }
}

static centred_summary centre_into(const narsil_store *store, narsil_metric metric, const double *normalised,
                                   double *centred) {
  centred_summary summary = {0, 0, HUGE_VAL, -HUGE_VAL};
  for (uint32_t i = 0; i < store->dimension; i++) {
    double centre = (double)store->centroid[i];
    centred[i] = normalised[i] - centre;
    summary.correction += metric == NARSIL_METRIC_EUCLIDEAN ? centred[i] * centred[i] : normalised[i] * centre;
    summary.total += centred[i];
    if (centred[i] < summary.minimum) { summary.minimum = centred[i]; }
    if (centred[i] > summary.maximum) { summary.maximum = centred[i]; }
  }
  return summary;
}

static level_range initial_range(const narsil_store *store, const double *centred, centred_summary summary,
                                 uint32_t query_bits) {
  uint32_t dimension = store->dimension;
  double mean = summary.total / dimension;
  double spread = 0;
  for (uint32_t i = 0; i < dimension; i++) { spread += (centred[i] - mean) * (centred[i] - mean); }
  double deviation = sqrt(spread / dimension);
  level_range observed = {summary.minimum, summary.maximum};
  level_range start = {clamp(mean - (grid_of(query_bits) * deviation), observed),
                       clamp(mean + (grid_of(query_bits) * deviation), observed)};
  refinement problem = {centred, dimension, steps_of(query_bits), 0};
  return refine(problem, start);
}

static void fill_levels(const narsil_store *store, const double *centred, prepared_code *code) {
  uint32_t dimension = store->dimension;
  uint32_t document_bits = store->bits;
  uint32_t per_byte = document_bits == 1 || document_bits == 2 ? BITS_PER_BYTE / document_bits : 0;
  uint32_t plane_bytes = per_byte == 0 ? 0 : code_bytes_of(dimension, document_bits);
  uint32_t pairs = (dimension + 1) / 2;
  double steps = steps_of(code->bits);
  memset(code->low_levels, 0, pairs);
  memset(code->high_levels, 0, pairs);
  memset(code->planes, 0, (size_t)QUERY_PLANES * plane_bytes);
  double sum = 0;
  for (uint32_t i = 0; i < dimension; i++) {
    uint8_t level = (uint8_t)level_of(centred[i], code->range, steps);
    code->levels[i] = level;
    sum += level;
    if ((i & 1) == 0) {
      code->low_levels[i >> 1] = level;
    } else {
      code->high_levels[i >> 1] = level;
    }
    if (per_byte == 0 || level == 0) { continue; }
    uint8_t bit = (uint8_t)(1U << ((i % per_byte) * document_bits));
    for (uint32_t plane = 0; plane < QUERY_PLANES; plane++) {
      if (((level >> plane) & 1) != 0) { code->planes[((size_t)plane * plane_bytes) + (i / per_byte)] |= bit; }
    }
  }
  code->sum = sum;
}

void prepare_code(narsil_workspace *workspace, const narsil_store *store, narsil_metric metric, const float *vector,
                  prepared_code *code) {
  double *normalised = workspace->normalised;
  double *centred = workspace->centred;
  if (metric == NARSIL_METRIC_COSINE) {
    normalise_into(normalised, vector, store->dimension);
  } else {
    for (uint32_t i = 0; i < store->dimension; i++) { normalised[i] = (double)vector[i]; }
  }
  centred_summary summary = centre_into(store, metric, normalised, centred);

  *code = workspace->code;
  code->bits = query_bits_of(store->bits);
  code->range = initial_range(store, centred, summary, code->bits);
  code->correction = summary.correction;
  fill_levels(store, centred, code);
}
