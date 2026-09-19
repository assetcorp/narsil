#include "values.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

napi_value throw_error(napi_env env, const char *message) {
  (void)napi_throw_error(env, "NARSIL_NATIVE", message);
  return NULL;
}

napi_value number_of(napi_env env, int32_t value) {
  napi_value result = NULL;
  if (napi_create_int32(env, value, &result) != napi_ok) { return NULL; }
  return result;
}

uint32_t clamped_count(size_t count) { return count > UINT32_MAX ? UINT32_MAX : (uint32_t)count; }

int typed_data(napi_env env, napi_value value, napi_typedarray_type expected, void **data, size_t *length) {
  bool is_typed = false;
  if (napi_is_typedarray(env, value, &is_typed) != napi_ok || !is_typed) { return 0; }
  napi_typedarray_type type = napi_int8_array;
  napi_value buffer = NULL;
  size_t offset = 0;
  if (napi_get_typedarray_info(env, value, &type, length, data, &buffer, &offset) != napi_ok) { return 0; }
  return type == expected && *data != NULL;
}
