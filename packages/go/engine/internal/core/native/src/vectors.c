#include "internal.h"

#include "../include/narsil_core.h"

#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#define CACHE_LINE_BYTES 64
#define PREFETCH_FOR_READ 0
#define PREFETCH_KEEP_IN_ALL_CACHES 3

int is_metric(uint32_t metric) {
  return metric == NARSIL_METRIC_COSINE || metric == NARSIL_METRIC_DOT_PRODUCT || metric == NARSIL_METRIC_EUCLIDEAN;
}

int is_code_width(uint32_t bits) {
  switch (bits) {
    case 0:
    case 1:
    case 2:
    case 4:
    case BITS_PER_BYTE:
      return 1;
    default:
      return 0;
  }
}

int store_is_complete(const narsil_store *store) {
  return store->header != NULL && store->code_present != NULL && store->centroid != NULL && store->magnitudes != NULL &&
         store->present != NULL && (store->code_block_count == 0 || store->code_blocks != NULL) &&
         (store->vector_block_count == 0 || store->vector_blocks != NULL) &&
         (store->file_count == 0 ||
          (store->files != NULL && store->vector_file != NULL && store->vector_offset != NULL));
}

static int holds_a_live_vector(const narsil_store *store, int32_t ordinal) {
  if (ordinal < 0) { return 0; }
  if ((uint32_t)ordinal >= (uint32_t)load_word(store->header, NARSIL_STORE_WORD_SLOTS)) { return 0; }
  return store->present[ordinal] == 1;
}

static const float *vector_in_a_file(const narsil_store *store, int32_t ordinal, float *scratch) {
  uint32_t position = (uint32_t)store->vector_file[ordinal];
  if (position >= store->file_count) { return NULL; }
  const narsil_vector_file *file = &store->files[position];
  uint64_t offset = store->vector_offset[ordinal];
  uint64_t bytes = (uint64_t)store->dimension * sizeof(float);
  if (file->bytes == NULL || offset + bytes > file->length) { return NULL; }
  memcpy(scratch, file->bytes + offset, (size_t)bytes);
  return scratch;
}

static const float *vector_in_a_block(const narsil_store *store, int32_t ordinal) {
  if (store->vectors_per_block == 0) { return NULL; }
  uint32_t block = (uint32_t)ordinal / store->vectors_per_block;
  if (block >= store->vector_block_count || store->vector_blocks[block] == NULL) { return NULL; }
  size_t entry = (size_t)((uint32_t)ordinal % store->vectors_per_block);
  return store->vector_blocks[block] + (entry * store->vector_stride_floats);
}

const float *stored_vector(const narsil_store *store, int32_t ordinal, float *scratch) {
  if (!holds_a_live_vector(store, ordinal)) { return NULL; }
  if (store->vector_file != NULL && store->vector_file[ordinal] >= 0) {
    return vector_in_a_file(store, ordinal, scratch);
  }
  return vector_in_a_block(store, ordinal);
}

uint8_t *stored_record(const narsil_store *store, int32_t ordinal) {
  if (ordinal < 0 || store->records_per_block == 0 || store->bits == 0) { return NULL; }
  if ((uint32_t)ordinal >= (uint32_t)load_word(store->header, NARSIL_STORE_WORD_SLOTS)) { return NULL; }
  uint32_t block = (uint32_t)ordinal / store->records_per_block;
  if (block >= store->code_block_count || store->code_blocks[block] == NULL) { return NULL; }
  size_t entry = (size_t)((uint32_t)ordinal % store->records_per_block);
  return store->code_blocks[block] + (entry * narsil_record_bytes(store->dimension, store->bits));
}

static double metric_distance(const walk_context *context, float_query query, const float *vector, double magnitude) {
  uint32_t dimension = context->store->dimension;
  if (context->metric == NARSIL_METRIC_EUCLIDEAN) {
    return sqrt((double)kernel_squared_distance(query.values, vector, dimension));
  }
  double dot = (double)kernel_dot(query.values, vector, dimension);
  if (context->metric == NARSIL_METRIC_DOT_PRODUCT) { return -dot; }
  if (query.magnitude == 0 || magnitude == 0) { return 1; }
  return 1 - (dot / (query.magnitude * magnitude));
}

double float_distance(const walk_context *context, float_query query, int32_t ordinal) {
  const float *vector = stored_vector(context->store, ordinal, context->workspace->stored_vector);
  if (vector == NULL) { return HUGE_VAL; }
  return metric_distance(context, query, vector, context->store->magnitudes[ordinal]);
}

static double vector_pair_distance(const walk_context *context, int32_t first, int32_t second) {
  const narsil_store *store = context->store;
  const float *first_vector = stored_vector(store, first, context->workspace->other_vector);
  if (first_vector == NULL) { return HUGE_VAL; }
  float_query query = {first_vector, store->magnitudes[first]};
  return float_distance(context, query, second);
}

double pair_distance(const walk_context *context, int32_t first, int32_t second) {
  if (context->pairs_use_codes) {
    const narsil_store *store = context->store;
    const uint8_t *first_record = stored_record(store, first);
    const uint8_t *second_record = stored_record(store, second);
    if (first_record != NULL && second_record != NULL && store->code_present[first] == 1 &&
        store->code_present[second] == 1) {
      return estimate_pair_distance(context, first_record, second_record);
    }
  }
  return vector_pair_distance(context, first, second);
}

void prefetch_for_walk(const walk_context *context, int32_t ordinal) {
#if defined(__GNUC__) || defined(__clang__)
  const uint8_t *bytes = NULL;
  size_t length = 0;
  if (context->uses_codes) {
    bytes = stored_record(context->store, ordinal);
    length = context->record_bytes;
  } else if (context->store->file_count == 0 && ordinal >= 0 && (uint32_t)ordinal < context->store_slots) {
    bytes = (const uint8_t *)vector_in_a_block(context->store, ordinal);
    length = (size_t)context->store->dimension * sizeof(float);
  }
  if (bytes == NULL || length == 0) { return; }
  for (size_t at = 0; at < length; at += CACHE_LINE_BYTES) {
    __builtin_prefetch(bytes + at, PREFETCH_FOR_READ, PREFETCH_KEEP_IN_ALL_CACHES);
  }
  __builtin_prefetch(bytes + length - 1, PREFETCH_FOR_READ, PREFETCH_KEEP_IN_ALL_CACHES);
#else
  (void)context;
  (void)ordinal;
#endif
}
