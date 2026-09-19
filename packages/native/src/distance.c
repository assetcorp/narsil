#include "internal.h"

#include "../include/narsil_core.h"

#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#define TRAILER_LOWER 0
#define TRAILER_UPPER 4
#define TRAILER_CORRECTION 8
#define TRAILER_SUM 12
#define CACHE_LINE_BYTES 64
#define PREFETCH_FOR_READ 0
#define PREFETCH_KEEP_IN_ALL_CACHES 3

int is_metric(uint32_t metric) {
  return metric == NARSIL_METRIC_COSINE || metric == NARSIL_METRIC_DOT_PRODUCT || metric == NARSIL_METRIC_EUCLIDEAN;
}

int store_is_complete(const narsil_store *store) {
  return store->header != NULL && store->code_present != NULL && store->centroid != NULL && store->magnitudes != NULL &&
         store->present != NULL && (store->code_block_count == 0 || store->code_blocks != NULL) &&
         (store->vector_block_count == 0 || store->vector_blocks != NULL);
}

static const float *vector_of(const narsil_store *store, int32_t ordinal) {
  if (ordinal < 0 || store->vectors_per_block == 0) { return NULL; }
  if ((uint32_t)ordinal >= (uint32_t)load_word(store->header, NARSIL_STORE_WORD_SLOTS)) { return NULL; }
  if (store->present[ordinal] != 1) { return NULL; }
  uint32_t block = (uint32_t)ordinal / store->vectors_per_block;
  if (block >= store->vector_block_count || store->vector_blocks[block] == NULL) { return NULL; }
  size_t entry = (size_t)((uint32_t)ordinal % store->vectors_per_block);
  return store->vector_blocks[block] + (entry * store->vector_stride_floats);
}

double float_distance(const narsil_store *store, narsil_metric metric, float_query query, int32_t ordinal) {
  const float *vector = vector_of(store, ordinal);
  if (vector == NULL) { return HUGE_VAL; }
  if (metric == NARSIL_METRIC_EUCLIDEAN) {
    return sqrt((double)kernel_squared_distance(query.values, vector, store->dimension));
  }
  double dot = (double)kernel_dot(query.values, vector, store->dimension);
  if (metric == NARSIL_METRIC_DOT_PRODUCT) { return -dot; }
  double magnitude = store->magnitudes[ordinal];
  if (query.magnitude == 0 || magnitude == 0) { return 1; }
  return 1 - (dot / (query.magnitude * magnitude));
}

static const uint8_t *record_of(const walk_context *context, int32_t ordinal) {
  const narsil_store *store = context->store;
  if (ordinal < 0 || (uint32_t)ordinal >= context->store_slots) { return NULL; }
  if (store->code_present[ordinal] != 1) { return NULL; }
  uint32_t block = (uint32_t)ordinal / store->records_per_block;
  if (block >= store->code_block_count || store->code_blocks[block] == NULL) { return NULL; }
  size_t entry = (size_t)((uint32_t)ordinal % store->records_per_block);
  return store->code_blocks[block] + (entry * context->record_bytes);
}

static uint32_t level_products(const walk_context *context, const uint8_t *record) {
  const narsil_store *store = context->store;
  const prepared_code *query = &context->code;
  if (store->bits == BITS_PER_BYTE) { return kernel_products_8x8(record, query->levels, store->dimension); }
  if (store->bits == 4) {
    return kernel_products_4x4(record, query->low_levels, query->high_levels, context->code_bytes);
  }
  packed_code document = {record, context->code_bytes, store->bits};
  return kernel_products_bits(document, query->planes);
}

static float trailer_float(const uint8_t *trailer, size_t offset) {
  float value = 0;
  memcpy(&value, trailer + offset, sizeof value);
  return value;
}

double estimate_distance(const walk_context *context, const uint8_t *record) {
  const narsil_store *store = context->store;
  const prepared_code *query = &context->code;
  uint32_t products = level_products(context, record);

  const uint8_t *trailer = record + context->code_bytes;
  uint32_t sum_of_levels = 0;
  memcpy(&sum_of_levels, trailer + TRAILER_SUM, sizeof sum_of_levels);
  double document_lower = (double)trailer_float(trailer, TRAILER_LOWER);
  double document_upper = (double)trailer_float(trailer, TRAILER_UPPER);
  double document_correction = (double)trailer_float(trailer, TRAILER_CORRECTION);
  double document_sum = sum_of_levels;
  double document_step = (document_upper - document_lower) / (double)((1U << store->bits) - 1);
  double query_step = (query->range.upper - query->range.lower) / (double)((1U << query->bits) - 1);
  double centred = (document_lower * query->range.lower * store->dimension) +
                   (query->range.lower * document_step * document_sum) + (document_lower * query_step * query->sum) +
                   (document_step * query_step * (double)products);
  if (context->metric == NARSIL_METRIC_EUCLIDEAN) {
    double squared = document_correction + query->correction - (2 * centred);
    return sqrt(squared > 0 ? squared : 0);
  }
  double similarity = centred + document_correction + query->correction - context->centroid_dot;
  if (context->metric == NARSIL_METRIC_DOT_PRODUCT) { return -similarity; }
  if (similarity < -1) { similarity = -1; }
  if (similarity > 1) { similarity = 1; }
  return 1 - similarity;
}

double walk_distance(const walk_context *context, int32_t ordinal) {
  if (!context->uses_codes) { return float_distance(context->store, context->metric, context->query, ordinal); }
  const uint8_t *record = record_of(context, ordinal);
  return record == NULL ? HUGE_VAL : estimate_distance(context, record);
}

void prefetch_for_walk(const walk_context *context, int32_t ordinal) {
  const uint8_t *bytes = NULL;
  size_t length = 0;
  if (context->uses_codes) {
    bytes = record_of(context, ordinal);
    length = context->record_bytes;
  } else {
    bytes = (const uint8_t *)vector_of(context->store, ordinal);
    length = (size_t)context->store->dimension * sizeof(float);
  }
  if (bytes == NULL) { return; }
#if defined(__GNUC__) || defined(__clang__)
  for (size_t at = 0; at < length; at += CACHE_LINE_BYTES) {
    __builtin_prefetch(bytes + at, PREFETCH_FOR_READ, PREFETCH_KEEP_IN_ALL_CACHES);
  }
  __builtin_prefetch(bytes + length - 1, PREFETCH_FOR_READ, PREFETCH_KEEP_IN_ALL_CACHES);
#endif
}

narsil_status narsil_rescore(const narsil_store *store, const float *query, uint32_t metric, const int32_t *ordinals,
                             uint32_t count, double *distances) {
  if (store == NULL || query == NULL || ordinals == NULL || distances == NULL) { return NARSIL_INVALID_ARGUMENT; }
  if (!store_is_complete(store) || !is_metric(metric)) { return NARSIL_INVALID_ARGUMENT; }
  float_query measured = {query, (double)kernel_magnitude(query, store->dimension)};
  for (uint32_t i = 0; i < count; i++) {
    distances[i] = float_distance(store, (narsil_metric)metric, measured, ordinals[i]);
  }
  return NARSIL_OK;
}
