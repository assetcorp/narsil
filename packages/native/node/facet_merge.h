#ifndef NARSIL_NODE_FACET_MERGE_H
#define NARSIL_NODE_FACET_MERGE_H

#include <js_native_api.h>

int define_facet_merge(napi_env env, napi_value exports);
napi_value boolean_facet(napi_env env, napi_callback_info info);
napi_value number_facet(napi_env env, napi_callback_info info);
napi_value range_facet(napi_env env, napi_callback_info info);
napi_value enum_facet(napi_env env, napi_callback_info info);
napi_value value_facet(napi_env env, napi_callback_info info);
napi_value stored_range_facet(napi_env env, napi_callback_info info);

#endif
