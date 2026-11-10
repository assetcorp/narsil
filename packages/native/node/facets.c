#include "facet_merge.h"

#include "../include/narsil_core.h"
#include "../include/narsil_facets.h"
#include "values.h"

#include <js_native_api_types.h>
#include <stddef.h>
#include <stdint.h>

enum { TRUE_BITS, FALSE_BITS, MATCHED, COUNTS, ARGUMENT_COUNT };

napi_value boolean_facet(napi_env env, napi_callback_info info) {
  napi_value argv[ARGUMENT_COUNT];
  void *data[ARGUMENT_COUNT] = {0};
  size_t lengths[ARGUMENT_COUNT] = {0};
  if (!callback_arguments(env, info, ARGUMENT_COUNT, argv)) { return number_of(env, -NARSIL_INVALID_ARGUMENT); }
  for (size_t index = 0; index < ARGUMENT_COUNT; index++) {
    if (!possibly_empty_typed_data(env, argv[index], napi_uint32_array, &data[index], &lengths[index])) {
      return number_of(env, -NARSIL_INVALID_ARGUMENT);
    }
  }
  narsil_boolean_index index = {data[TRUE_BITS], lengths[TRUE_BITS], data[FALSE_BITS], lengths[FALSE_BITS]};
  return number_of(
      env, -(int32_t)narsil_boolean_facet(&index, data[MATCHED], lengths[MATCHED], data[COUNTS], lengths[COUNTS]));
}

napi_value enum_facet(napi_env env, napi_callback_info info) {
  napi_value argv[ARGUMENT_COUNT];
  void *data[ARGUMENT_COUNT] = {0};
  size_t lengths[ARGUMENT_COUNT] = {0};
  thread_state *state = thread_state_of(env);
  if (state == NULL || !callback_arguments(env, info, ARGUMENT_COUNT, argv)) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  for (size_t index = 0; index < ARGUMENT_COUNT; index++) {
    if (!possibly_empty_typed_data(env, argv[index], napi_uint32_array, &data[index], &lengths[index])) {
      return number_of(env, -NARSIL_INVALID_ARGUMENT);
    }
  }
  narsil_status status = narsil_enum_facet(state->workspace, data[0], lengths[0], data[1], lengths[1], data[2],
                                           lengths[2], data[3], lengths[3]);
  report_workspace_memory(env, state);
  return number_of(env, -(int32_t)status);
}
