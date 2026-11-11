#include "math_batch.h"

#include "values.h"

#include "../include/narsil_math.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <stddef.h>
#include <stdint.h>

enum { APPLY_FUNCTION, APPLY_FIRST, APPLY_SECOND, APPLY_RESULTS, APPLY_ARGUMENT_COUNT };

static napi_value apply_math(napi_env env, napi_callback_info info) {
  napi_value argv[APPLY_ARGUMENT_COUNT];
  uint32_t function = 0;
  narsil_math_batch batch = {NULL, NULL, NULL, 0};
  void *first = NULL;
  void *second = NULL;
  void *results = NULL;
  size_t first_length = 0;
  size_t second_length = 0;
  if (!callback_arguments(env, info, APPLY_ARGUMENT_COUNT, argv) ||
      napi_get_value_uint32(env, argv[APPLY_FUNCTION], &function) != napi_ok ||
      function >= NARSIL_MATH_FUNCTION_COUNT ||
      !possibly_empty_typed_data(env, argv[APPLY_FIRST], napi_float64_array, &first, &first_length) ||
      !possibly_empty_typed_data(env, argv[APPLY_SECOND], napi_float64_array, &second, &second_length) ||
      !possibly_empty_typed_data(env, argv[APPLY_RESULTS], napi_float64_array, &results, &batch.count) ||
      first_length != batch.count || (function == NARSIL_MATH_ATAN2 && second_length != batch.count)) {
    return throw_error(env, "applyMath takes a function index and Float64Arrays of equal length");
  }
  batch.first = first;
  batch.second = function == NARSIL_MATH_ATAN2 ? second : NULL;
  batch.results = results;
  return status_of(env, narsil_math_apply((narsil_math_function)function, &batch));
}

int define_math(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"applyMath", NULL, apply_math, NULL, NULL, NULL, napi_default_method, NULL},
  };
  return napi_define_properties(env, exports, sizeof properties / sizeof properties[0], properties) == napi_ok;
}
