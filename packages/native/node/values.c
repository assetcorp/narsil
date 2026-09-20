#include "values.h"

#include "field.h"

#include "../include/narsil_core.h"

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

napi_value status_of(napi_env env, narsil_status status) { return number_of(env, (int32_t)status); }

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

int callback_arguments(napi_env env, napi_callback_info info, size_t expected, napi_value *argv) {
  size_t argc = expected;
  return napi_get_cb_info(env, info, &argc, argv, NULL, NULL) == napi_ok && argc == expected;
}

attached_graph *graph_of(napi_env env, napi_value value) {
  void *data = NULL;
  if (napi_get_value_external(env, value, &data) != napi_ok || data == NULL) { return NULL; }
  attached_graph *attached = data;
  return attached->kind == ATTACHED_GRAPH_KIND ? attached : NULL;
}

attached_store *store_of(napi_env env, napi_value value) {
  void *data = NULL;
  if (napi_get_value_external(env, value, &data) != napi_ok || data == NULL) { return NULL; }
  attached_store *attached = data;
  return attached->kind == ATTACHED_STORE_KIND && !attached->detached ? attached : NULL;
}

thread_state *thread_state_of(napi_env env) {
  void *data = NULL;
  if (napi_get_instance_data(env, &data) != napi_ok) { return NULL; }
  return data;
}

void report_workspace_memory(napi_env env, thread_state *state) {
  int64_t held = (int64_t)narsil_workspace_bytes(state->workspace);
  if (held == state->reported_bytes) { return; }
  int64_t adjusted = 0;
  if (napi_adjust_external_memory(env, held - state->reported_bytes, &adjusted) == napi_ok) {
    state->reported_bytes = held;
  }
}
