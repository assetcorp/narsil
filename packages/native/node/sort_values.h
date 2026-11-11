#ifndef NARSIL_NODE_SORT_VALUES_H
#define NARSIL_NODE_SORT_VALUES_H

#include "../include/narsil_sort_order.h"

#include <js_native_api_types.h>

enum { SORT_FIELD_REGIONS = 5 };

typedef struct {
  napi_value regions[SORT_FIELD_REGIONS];
} sort_field_handles;

int prepare_sort_field(napi_env env, napi_value descriptor, sort_field_handles *handles);
int read_sort_field(napi_env env, const sort_field_handles *handles, narsil_sort_values *values);
int read_sort_field_output(napi_env env, const sort_field_handles *handles, narsil_sort_values_output *values);
napi_value build_sort_order(napi_env env, napi_callback_info info);
napi_value text_range(napi_env env, napi_callback_info info);
napi_value sort_select(napi_env env, napi_callback_info info);

#endif
