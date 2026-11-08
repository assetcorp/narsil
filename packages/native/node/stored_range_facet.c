#include "facet_merge.h"

#include "../include/narsil_core.h"
#include "../include/narsil_facets.h"
#include "../include/narsil_stored_values.h"
#include "stored_values.h"
#include "values.h"

#include <js_native_api_types.h>
#include <stddef.h>
#include <stdint.h>

enum { VALUES, MATCHED, RANGES, COUNTS, ARGUMENT_COUNT };

napi_value stored_range_facet(napi_env env, napi_callback_info info) {
  napi_value argv[ARGUMENT_COUNT];
  stored_field_handles handles = {0};
  narsil_stored_values values = {0};
  void *data[ARGUMENT_COUNT] = {0};
  size_t lengths[ARGUMENT_COUNT] = {0};
  if (!callback_arguments(env, info, ARGUMENT_COUNT, argv) || !prepare_stored_field(env, argv[VALUES], &handles) ||
      !read_stored_field(env, &handles, &values)) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  for (size_t at = MATCHED; at < ARGUMENT_COUNT; at++) {
    napi_typedarray_type type = at == RANGES ? napi_float64_array : napi_uint32_array;
    if (!possibly_empty_typed_data(env, argv[at], type, &data[at], &lengths[at])) {
      return number_of(env, -NARSIL_INVALID_ARGUMENT);
    }
  }
  return number_of(env, -(int32_t)narsil_stored_range_facet(&values, data[MATCHED], lengths[MATCHED], data[RANGES],
                                                            lengths[RANGES], data[COUNTS], lengths[COUNTS]));
}
