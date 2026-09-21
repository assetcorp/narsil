#include "internal.h"

#include "../include/narsil_core.h"

#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

typedef struct {
  double lower;
  double upper;
  double correction;
  double sum;
  uint32_t bits;
} code_summary;

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

static code_summary summary_of_record(const walk_context *context, const uint8_t *record) {
  const uint8_t *trailer = record + context->code_bytes;
  uint32_t sum_of_levels = 0;
  memcpy(&sum_of_levels, trailer + TRAILER_SUM, sizeof sum_of_levels);
  code_summary summary = {(double)trailer_float(trailer, TRAILER_LOWER), (double)trailer_float(trailer, TRAILER_UPPER),
                          (double)trailer_float(trailer, TRAILER_CORRECTION), (double)sum_of_levels,
                          context->store->bits};
  return summary;
}

static double distance_from_products(const walk_context *context, uint32_t products, code_summary document,
                                     code_summary query) {
  double document_step = (document.upper - document.lower) / (double)((1U << document.bits) - 1);
  double query_step = (query.upper - query.lower) / (double)((1U << query.bits) - 1);
  double centred = (document.lower * query.lower * context->store->dimension) +
                   (query.lower * document_step * document.sum) + (document.lower * query_step * query.sum) +
                   (document_step * query_step * (double)products);
  if (context->metric == NARSIL_METRIC_EUCLIDEAN) {
    double squared = document.correction + query.correction - (2 * centred);
    return sqrt(squared > 0 ? squared : 0);
  }
  double similarity = centred + document.correction + query.correction - context->centroid_dot;
  if (context->metric == NARSIL_METRIC_DOT_PRODUCT) { return -similarity; }
  if (similarity < -1) { similarity = -1; }
  if (similarity > 1) { similarity = 1; }
  return 1 - similarity;
}

double estimate_distance(const walk_context *context, const uint8_t *record) {
  const prepared_code *code = &context->code;
  code_summary query = {code->range.lower, code->range.upper, code->correction, code->sum, code->bits};
  return distance_from_products(context, level_products(context, record), summary_of_record(context, record), query);
}

double estimate_pair_distance(const walk_context *context, const uint8_t *first, const uint8_t *second) {
  packed_code document = {first, context->code_bytes, context->store->bits};
  uint32_t products = kernel_pair_products(document, second, context->store->dimension);
  return distance_from_products(context, products, summary_of_record(context, first),
                                summary_of_record(context, second));
}

double walk_distance(const walk_context *context, int32_t ordinal) {
  if (!context->uses_codes) { return float_distance(context, context->query, ordinal); }
  if (ordinal < 0 || (uint32_t)ordinal >= context->store_slots) { return HUGE_VAL; }
  if (context->store->code_present[ordinal] != 1) { return HUGE_VAL; }
  const uint8_t *record = stored_record(context->store, ordinal);
  return record == NULL ? HUGE_VAL : estimate_distance(context, record);
}

narsil_status narsil_score(narsil_workspace *workspace, const narsil_store *store, const narsil_score_request *request,
                           double *distances) {
  if (workspace == NULL || store == NULL || request == NULL || distances == NULL) { return NARSIL_INVALID_ARGUMENT; }
  if (request->query == NULL || (request->count > 0 && request->ordinals == NULL)) { return NARSIL_INVALID_ARGUMENT; }
  if (!store_is_complete(store) || !is_metric(request->metric) || store->dimension == 0) {
    return NARSIL_INVALID_ARGUMENT;
  }
  narsil_status status = workspace_reserve_dimension(workspace, store->dimension);
  if (status != NARSIL_OK) { return status; }
  walk_context context;
  memset(&context, 0, sizeof context);
  context.store = store;
  context.workspace = workspace;
  context.metric = (narsil_metric)request->metric;
  float_query measured = {request->query, (double)kernel_magnitude(request->query, store->dimension)};
  for (uint32_t i = 0; i < request->count; i++) {
    distances[i] = float_distance(&context, measured, request->ordinals[i]);
  }
  return NARSIL_OK;
}
