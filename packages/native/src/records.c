#include "internal.h"

#include "../include/narsil_core.h"

#include <math.h>
#include <stdatomic.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

static narsil_status begin_record_work(narsil_workspace *workspace, const narsil_store *store,
                                       const narsil_ordinals_request *request) {
  if (workspace == NULL || store == NULL || request == NULL) { return NARSIL_INVALID_ARGUMENT; }
  if (request->count > 0 && request->ordinals == NULL) { return NARSIL_INVALID_ARGUMENT; }
  if (!store_is_complete(store) || !is_metric(request->metric) || store->dimension == 0) {
    return NARSIL_INVALID_ARGUMENT;
  }
  if (store->bits == 0 || !is_code_width(store->bits) || store->records_per_block == 0) {
    return NARSIL_INVALID_ARGUMENT;
  }
  return workspace_reserve_dimension(workspace, store->dimension);
}

static uint32_t sum_vectors(narsil_workspace *workspace, const narsil_store *store,
                            const narsil_ordinals_request *request, double *sums) {
  uint32_t summed = 0;
  for (uint32_t i = 0; i < request->count; i++) {
    const float *vector = stored_vector(store, request->ordinals[i], workspace->stored_vector);
    if (vector == NULL) { continue; }
    if (request->metric == NARSIL_METRIC_COSINE) {
      normalise_into(workspace->normalised, vector, store->dimension);
      for (uint32_t axis = 0; axis < store->dimension; axis++) { sums[axis] += workspace->normalised[axis]; }
    } else {
      for (uint32_t axis = 0; axis < store->dimension; axis++) { sums[axis] += (double)vector[axis]; }
    }
    summed += 1;
  }
  return summed;
}

static void store_centroid(const narsil_store *store, uint32_t metric, double *sums, uint32_t summed) {
  double squares = 0;
  for (uint32_t axis = 0; axis < store->dimension; axis++) {
    sums[axis] /= summed;
    squares += sums[axis] * sums[axis];
  }
  double length = metric == NARSIL_METRIC_COSINE ? sqrt(squares) : 0;
  for (uint32_t axis = 0; axis < store->dimension; axis++) {
    store->centroid[axis] = (float)(length == 0 ? sums[axis] : sums[axis] / length);
  }
}

narsil_status narsil_calibrate(narsil_workspace *workspace, const narsil_store *store,
                               const narsil_ordinals_request *request) {
  narsil_status status = begin_record_work(workspace, store, request);
  if (status != NARSIL_OK) { return status; }
  double *sums = workspace->centred;
  memset(sums, 0, (size_t)store->dimension * sizeof *sums);
  uint32_t summed = sum_vectors(workspace, store, request, sums);
  if (summed == 0) { return NARSIL_OK; }
  store_centroid(store, request->metric, sums, summed);
  atomic_fetch_add(atomic_word(store->header, NARSIL_STORE_WORD_CALIBRATION_GENERATION), 1);
  atomic_store(atomic_word(store->header, NARSIL_STORE_WORD_CALIBRATED), 1);
  return NARSIL_OK;
}

static uint32_t pack_levels(const narsil_store *store, const quantised_vector *quantised, uint8_t *record) {
  uint32_t bits = store->bits;
  uint32_t per_byte = BITS_PER_BYTE / bits;
  uint32_t sum = 0;
  memset(record, 0, code_bytes_of(store->dimension, bits));
  for (uint32_t i = 0; i < store->dimension; i++) {
    uint32_t level = (uint32_t)quantised_level(quantised->centred[i], quantised->range, bits);
    sum += level;
    record[i / per_byte] |= (uint8_t)(level << ((i % per_byte) * bits));
  }
  return sum;
}

static void write_record(const narsil_store *store, const quantised_vector *quantised, uint8_t *record) {
  uint32_t sum = pack_levels(store, quantised, record);
  uint8_t *trailer = record + code_bytes_of(store->dimension, store->bits);
  float lower = (float)quantised->range.lower;
  float upper = (float)quantised->range.upper;
  float correction = (float)quantised->correction;
  memcpy(trailer + TRAILER_LOWER, &lower, sizeof lower);
  memcpy(trailer + TRAILER_UPPER, &upper, sizeof upper);
  memcpy(trailer + TRAILER_CORRECTION, &correction, sizeof correction);
  memcpy(trailer + TRAILER_SUM, &sum, sizeof sum);
}

narsil_status narsil_quantise(narsil_workspace *workspace, const narsil_store *store,
                              const narsil_ordinals_request *request) {
  narsil_status status = begin_record_work(workspace, store, request);
  if (status != NARSIL_OK) { return status; }
  if (load_word(store->header, NARSIL_STORE_WORD_CALIBRATED) != 1) { return NARSIL_INVALID_ARGUMENT; }
  for (uint32_t i = 0; i < request->count; i++) {
    int32_t ordinal = request->ordinals[i];
    const float *vector = stored_vector(store, ordinal, workspace->stored_vector);
    uint8_t *record = stored_record(store, ordinal);
    if (vector == NULL) { continue; }
    if (record == NULL) { return NARSIL_NEEDS_ROOM; }
    quantised_vector quantised;
    quantise_vector(workspace, store, (narsil_metric)request->metric, vector, store->bits, &quantised);
    write_record(store, &quantised, record);
    _Atomic(uint8_t) *holds_a_record = atomic_byte(store->code_present, (uint32_t)ordinal);
    if (atomic_load(holds_a_record) == 0) {
      atomic_fetch_add(atomic_word(store->header, NARSIL_STORE_WORD_CODE_COUNT), 1);
      atomic_store(holds_a_record, 1);
    }
  }
  return NARSIL_OK;
}
