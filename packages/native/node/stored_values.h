#ifndef NARSIL_NODE_STORED_VALUES_H
#define NARSIL_NODE_STORED_VALUES_H

#include "../include/narsil_core.h"
#include "../include/narsil_stored_values.h"

#include <js_native_api_types.h>
#include <stdint.h>

enum { STORED_FIELD_REGIONS = 8 };

typedef struct {
  napi_value regions[STORED_FIELD_REGIONS];
} stored_field_handles;

typedef struct {
  uint32_t count;
  stored_field_handles *handles;
  narsil_stored_values *values;
} stored_fields;

narsil_status prepare_stored_fields(napi_env env, napi_value array, stored_fields *fields);
int prepare_stored_field(napi_env env, napi_value descriptor, stored_field_handles *handles);
int read_stored_field(napi_env env, const stored_field_handles *handles, narsil_stored_values *values);
int read_stored_fields(napi_env env, stored_fields *fields);
void release_stored_fields(stored_fields *fields);

#endif
