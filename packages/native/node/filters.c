#include "filters.h"
#include "../include/narsil_core.h"
#include "../include/narsil_filters.h"
#include "../src/regions.h"

#include "values.h"
#include <js_native_api.h>
#include <js_native_api_types.h>

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

enum { PLAN, NUMBERS, UNITS, OFFSETS, LISTS, BITSETS, KINDS, FIELDS, LIVE, INTO, ARGUMENT_COUNT };

typedef struct {
  napi_value values[NARSIL_FILTER_FIELD_REGIONS];
  uint32_t count;
} field_handles;

typedef struct {
  field_handles *fields;
  napi_value *bitsets;
  narsil_filter_field *field_values;
  narsil_filter_bits *bitset_values;
  uint32_t field_count;
  uint32_t bitset_count;
} filter_handles;

static int array_length(napi_env env, napi_value value, uint32_t *length) {
  bool array = false;
  return napi_is_array(env, value, &array) == napi_ok && array && napi_get_array_length(env, value, length) == napi_ok;
}

static narsil_status prepare(napi_env env, const napi_value *argv, filter_handles *held) {
  if (!array_length(env, argv[FIELDS], &held->field_count) || !array_length(env, argv[BITSETS], &held->bitset_count)) {
    return NARSIL_INVALID_ARGUMENT;
  }
  size_t fields = held->field_count;
  size_t bitsets = held->bitset_count;
  if (fields > SIZE_MAX / sizeof *held->fields || fields > SIZE_MAX / sizeof *held->field_values ||
      bitsets > SIZE_MAX / sizeof *held->bitsets || bitsets > SIZE_MAX / sizeof *held->bitset_values) {
    return NARSIL_INVALID_ARGUMENT;
  }
  if (fields > 0) {
    held->fields = calloc(fields, sizeof *held->fields);
    held->field_values = calloc(fields, sizeof *held->field_values);
    if (held->fields == NULL || held->field_values == NULL) { return NARSIL_OUT_OF_MEMORY; }
  }
  if (bitsets > 0) {
    held->bitsets = (napi_value *)calloc(bitsets, sizeof *held->bitsets);
    held->bitset_values = calloc(bitsets, sizeof *held->bitset_values);
    if (held->bitsets == NULL || held->bitset_values == NULL) { return NARSIL_OUT_OF_MEMORY; }
  }
  for (uint32_t at = 0; at < held->field_count; at++) {
    napi_value field = NULL;
    field_handles *handles = &held->fields[at];
    if (napi_get_element(env, argv[FIELDS], at, &field) != napi_ok || !array_length(env, field, &handles->count) ||
        handles->count == 0 || handles->count > NARSIL_FILTER_FIELD_REGIONS) {
      return NARSIL_INVALID_ARGUMENT;
    }
    for (uint32_t region = 0; region < handles->count; region++) {
      if (napi_get_element(env, field, region, &handles->values[region]) != napi_ok) { return NARSIL_INVALID_ARGUMENT; }
    }
  }
  for (uint32_t at = 0; at < held->bitset_count; at++) {
    if (napi_get_element(env, argv[BITSETS], at, &held->bitsets[at]) != napi_ok) { return NARSIL_INVALID_ARGUMENT; }
  }
  return NARSIL_OK;
}

static int read_fields(napi_env env, filter_handles *held, const uint8_t *kinds) {
  static const uint32_t counts[] = {1, 3, 3, 6, 5};
  static const napi_typedarray_type types[][NARSIL_FILTER_FIELD_REGIONS] = {
      {napi_uint32_array},
      {napi_uint32_array, napi_float64_array, napi_uint32_array},
      {napi_uint32_array, napi_uint32_array, napi_uint32_array},
      {napi_uint32_array, napi_uint16_array, napi_uint32_array, napi_uint32_array, napi_uint32_array,
       napi_uint32_array},
      {napi_uint32_array, napi_biguint64_array, napi_float64_array, napi_float64_array, napi_uint32_array}};
  for (uint32_t at = 0; at < held->field_count; at++) {
    uint32_t kind = kinds[at];
    if (kind > NARSIL_FILTER_GEO || held->fields[at].count != counts[kind]) { return 0; }
    narsil_filter_field *field = &held->field_values[at];
    field->kind = kind;
    field->region_count = counts[kind];
    for (uint32_t region = 0; region < counts[kind]; region++) {
      void *data = NULL;
      if (!possibly_empty_typed_data(env, held->fields[at].values[region], types[kind][region], &data,
                                     &field->regions[region].length)) {
        return 0;
      }
      field->regions[region].data = data;
    }
  }
  for (uint32_t at = 0; at < held->bitset_count; at++) {
    void *data = NULL;
    if (!possibly_empty_typed_data(env, held->bitsets[at], napi_uint32_array, &data, &held->bitset_values[at].count)) {
      return 0;
    }
    held->bitset_values[at].words = data;
  }
  return 1;
}

static narsil_status execute(napi_env env, thread_state *state, const napi_value *argv, filter_handles *held) {
  static const napi_typedarray_type types[ARGUMENT_COUNT] = {
      napi_uint32_array, napi_float64_array, napi_uint16_array, napi_uint32_array, napi_uint32_array,
      napi_uint32_array, napi_uint8_array,   napi_uint32_array, napi_uint32_array, napi_uint32_array};
  void *data[ARGUMENT_COUNT] = {0};
  size_t lengths[ARGUMENT_COUNT] = {0};
  for (size_t at = 0; at < ARGUMENT_COUNT; at++) {
    if (at == FIELDS || at == BITSETS) { continue; }
    if (!possibly_empty_typed_data(env, argv[at], types[at], &data[at], &lengths[at])) {
      return NARSIL_INVALID_ARGUMENT;
    }
  }
  memory_region output;
  memory_region kinds;
  if (lengths[KINDS] != held->field_count || !region_of(data[INTO], lengths[INTO], sizeof(uint32_t), &output) ||
      !region_of(data[KINDS], lengths[KINDS], sizeof(uint8_t), &kinds) || overlaps(output, kinds) ||
      !read_fields(env, held, data[KINDS])) {
    return NARSIL_INVALID_ARGUMENT;
  }
  narsil_filter_program program = {
      data[PLAN],          lengths[PLAN],      data[NUMBERS],      lengths[NUMBERS],  data[UNITS],
      lengths[UNITS],      data[OFFSETS],      lengths[OFFSETS],   data[LISTS],       lengths[LISTS],
      held->bitset_values, held->bitset_count, held->field_values, held->field_count, {data[LIVE], lengths[LIVE]}};
  return narsil_evaluate_filter(state->workspace, &program, data[INTO], lengths[INTO]);
}

static napi_value evaluate_filter(napi_env env, napi_callback_info info) {
  napi_value argv[ARGUMENT_COUNT];
  thread_state *state = thread_state_of(env);
  if (state == NULL || !callback_arguments(env, info, ARGUMENT_COUNT, argv)) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  filter_handles held = {0};
  narsil_status status = prepare(env, argv, &held);
  if (status == NARSIL_OK) { status = execute(env, state, argv, &held); }
  free(held.fields);
  free((void *)held.bitsets);
  free(held.field_values);
  free(held.bitset_values);
  report_workspace_memory(env, state);
  return number_of(env, -(int32_t)status);
}

int define_filters(napi_env env, napi_value exports) {
  napi_property_descriptor property = {"evaluateFilter",    NULL, evaluate_filter, NULL, NULL, NULL,
                                       napi_default_method, NULL};
  return napi_define_properties(env, exports, 1, &property) == napi_ok;
}
