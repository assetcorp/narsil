#ifndef NARSIL_NODE_VALUES_H
#define NARSIL_NODE_VALUES_H

#include "field.h"

#include "../include/narsil_core.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <node_api.h>
#include <stddef.h>
#include <stdint.h>

typedef struct {
  narsil_workspace *workspace;
  int64_t reported_bytes;
} thread_state;

napi_value throw_error(napi_env env, const char *message);
napi_value number_of(napi_env env, int32_t value);
napi_value status_of(napi_env env, narsil_status status);
uint32_t clamped_count(size_t count);
int typed_data(napi_env env, napi_value value, napi_typedarray_type expected, void **data, size_t *length);
int callback_arguments(napi_env env, napi_callback_info info, size_t expected, napi_value *argv);
attached_graph *graph_of(napi_env env, napi_value value);
attached_store *store_of(napi_env env, napi_value value);
thread_state *thread_state_of(napi_env env);
void report_workspace_memory(napi_env env, thread_state *state);

#endif
