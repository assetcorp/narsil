#include "facet_merge.h"

#include "../include/narsil_core.h"
#include "../include/narsil_facets.h"
#include "../include/narsil_stored_values.h"
#include "stored_values.h"
#include "values.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <stddef.h>
#include <stdint.h>

enum { VALUES, MATCHED, OUT_VALUES, OUT_COUNTS, ARGUMENT_COUNT };

napi_value value_facet(napi_env env, napi_callback_info info) {
  napi_value argv[ARGUMENT_COUNT];
  stored_field_handles handles = {0};
  narsil_stored_values values = {0};
  void *data[ARGUMENT_COUNT] = {0};
  size_t lengths[ARGUMENT_COUNT] = {0};
  thread_state *state = thread_state_of(env);
  if (state == NULL || !callback_arguments(env, info, ARGUMENT_COUNT, argv) ||
      !prepare_stored_field(env, argv[VALUES], &handles) || !read_stored_field(env, &handles, &values)) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  for (size_t at = MATCHED; at < ARGUMENT_COUNT; at++) {
    if (!possibly_empty_typed_data(env, argv[at], napi_uint32_array, &data[at], &lengths[at])) {
      return number_of(env, -NARSIL_INVALID_ARGUMENT);
    }
  }
  narsil_value_facet_output output = {data[OUT_VALUES], lengths[OUT_VALUES], data[OUT_COUNTS], lengths[OUT_COUNTS]};
  uint32_t count = 0;
  narsil_status status =
      narsil_value_facet(state->workspace, &values, data[MATCHED], lengths[MATCHED], &output, &count);
  report_workspace_memory(env, state);
  if (status != NARSIL_OK) { return number_of(env, -(int32_t)status); }
  napi_value result = NULL;
  if (napi_create_uint32(env, count, &result) != napi_ok) { return NULL; }
  return result;
}
