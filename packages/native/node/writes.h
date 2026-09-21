#ifndef NARSIL_NODE_WRITES_H
#define NARSIL_NODE_WRITES_H

#include <js_native_api_types.h>

napi_value place(napi_env env, napi_callback_info info);
napi_value remove_node(napi_env env, napi_callback_info info);
napi_value compact(napi_env env, napi_callback_info info);
napi_value calibrate(napi_env env, napi_callback_info info);
napi_value quantise(napi_env env, napi_callback_info info);

#endif
