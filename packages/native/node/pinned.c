#include "pinned.h"

#include "values.h"

#include "../include/narsil_core.h"
#include "../include/narsil_pinned.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <math.h>
#include <stddef.h>
#include <stdint.h>

enum { PINNED_COUNT, PINNED_RANKED, PINNED_POSITIONS, PINNED_DEPTH, PINNED_OUTPUT, PINNED_ARGUMENT_COUNT };

static int uint32_argument(napi_env env, napi_value value, uint32_t *result) {
  double number = 0;
  if (napi_get_value_double(env, value, &number) != napi_ok || !isfinite(number) || number < 0 || number > UINT32_MAX ||
      number != floor(number)) {
    return 0;
  }
  *result = (uint32_t)number;
  return 1;
}

static napi_value place_pinned(napi_env env, napi_callback_info info) {
  napi_value argv[PINNED_ARGUMENT_COUNT];
  narsil_pinned_request request = {0};
  narsil_pinned_output output = {0};
  void *ranked = NULL;
  void *positions = NULL;
  void *entries = NULL;
  napi_valuetype depth_type = napi_undefined;
  thread_state *state = thread_state_of(env);
  if (state == NULL || !callback_arguments(env, info, PINNED_ARGUMENT_COUNT, argv) ||
      !uint32_argument(env, argv[PINNED_COUNT], &request.count) ||
      !possibly_empty_typed_data(env, argv[PINNED_RANKED], napi_int32_array, &ranked, &request.ranked_count) ||
      !possibly_empty_typed_data(env, argv[PINNED_POSITIONS], napi_uint32_array, &positions, &request.position_count) ||
      !possibly_empty_typed_data(env, argv[PINNED_OUTPUT], napi_int32_array, &entries, &output.capacity) ||
      napi_typeof(env, argv[PINNED_DEPTH], &depth_type) != napi_ok) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  request.has_depth = depth_type != napi_null;
  if (request.has_depth != 0 && !uint32_argument(env, argv[PINNED_DEPTH], &request.depth)) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  request.ranked = ranked;
  request.positions = positions;
  output.entries = entries;
  narsil_status status = narsil_place_pinned(state->workspace, &request, &output);
  report_workspace_memory(env, state);
  if (status != NARSIL_OK) { return number_of(env, -(int32_t)status); }
  napi_value result = NULL;
  if (napi_create_uint32(env, output.count, &result) != napi_ok) { return NULL; }
  return result;
}

int define_pinned(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"placePinned", NULL, place_pinned, NULL, NULL, NULL, napi_default_method, NULL},
  };
  return napi_define_properties(env, exports, sizeof properties / sizeof properties[0], properties) == napi_ok;
}
