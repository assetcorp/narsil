#include "facet_merge.h"

#include "../include/narsil_core.h"
#include "../include/narsil_facets.h"
#include "values.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <stddef.h>
#include <stdint.h>

enum { VALUES, ORDINALS, MATCHED, FOURTH, COUNTS, ARGUMENT_COUNT };

static int arguments_of(napi_env env, napi_callback_info info, void **data, size_t *lengths) {
  napi_value argv[ARGUMENT_COUNT];
  if (!callback_arguments(env, info, ARGUMENT_COUNT, argv)) { return 0; }
  for (size_t at = 0; at < ARGUMENT_COUNT; at++) {
    napi_typedarray_type type = at == VALUES || at == FOURTH ? napi_float64_array : napi_uint32_array;
    if (!possibly_empty_typed_data(env, argv[at], type, &data[at], &lengths[at])) { return 0; }
  }
  return 1;
}

napi_value number_facet(napi_env env, napi_callback_info info) {
  void *data[ARGUMENT_COUNT] = {0};
  size_t lengths[ARGUMENT_COUNT] = {0};
  thread_state *state = thread_state_of(env);
  if (state == NULL || !arguments_of(env, info, data, lengths)) { return number_of(env, -NARSIL_INVALID_ARGUMENT); }
  narsil_numeric_facet_input input = {data[VALUES],      lengths[VALUES], data[ORDINALS],
                                      lengths[ORDINALS], data[MATCHED],   lengths[MATCHED]};
  narsil_number_facet_output output = {data[FOURTH], lengths[FOURTH], data[COUNTS], lengths[COUNTS]};
  uint32_t count = 0;
  narsil_status status = narsil_number_facet(state->workspace, &input, &output, &count);
  report_workspace_memory(env, state);
  if (status != NARSIL_OK) { return number_of(env, -(int32_t)status); }
  napi_value result = NULL;
  if (napi_create_uint32(env, count, &result) != napi_ok) { return NULL; }
  return result;
}

napi_value range_facet(napi_env env, napi_callback_info info) {
  void *data[ARGUMENT_COUNT] = {0};
  size_t lengths[ARGUMENT_COUNT] = {0};
  thread_state *state = thread_state_of(env);
  if (state == NULL || !arguments_of(env, info, data, lengths)) { return number_of(env, -NARSIL_INVALID_ARGUMENT); }
  narsil_numeric_facet_input input = {data[VALUES],      lengths[VALUES], data[ORDINALS],
                                      lengths[ORDINALS], data[MATCHED],   lengths[MATCHED]};
  narsil_status status =
      narsil_range_facet(state->workspace, &input, data[FOURTH], lengths[FOURTH], data[COUNTS], lengths[COUNTS]);
  report_workspace_memory(env, state);
  return number_of(env, -(int32_t)status);
}
