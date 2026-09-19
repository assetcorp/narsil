#ifndef NARSIL_NODE_VALUES_H
#define NARSIL_NODE_VALUES_H

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <node_api.h>
#include <stddef.h>
#include <stdint.h>

napi_value throw_error(napi_env env, const char *message);
napi_value number_of(napi_env env, int32_t value);
uint32_t clamped_count(size_t count);
int typed_data(napi_env env, napi_value value, napi_typedarray_type expected, void **data, size_t *length);

#endif
