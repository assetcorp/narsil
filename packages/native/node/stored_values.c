#include "stored_values.h"

#include "values.h"

#include "../include/narsil_core.h"
#include "../include/narsil_stored_values.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

enum { SHAPES, STARTS, KINDS, NUMBERS, TEXT_START, TEXT_LENGTH, UNITS, BYTES };

static const char *const FIELD_PROPERTIES[STORED_FIELD_REGIONS] = {
    "shapes", "starts", "kinds", "numbers", "textStart", "textLength", "units", "bytes",
};

static const napi_typedarray_type FIELD_TYPES[STORED_FIELD_REGIONS] = {
    napi_uint8_array,  napi_uint32_array, napi_uint8_array,  napi_float64_array,
    napi_uint32_array, napi_uint32_array, napi_uint16_array, napi_uint8_array,
};

void release_stored_fields(stored_fields *fields) {
  free(fields->handles);
  free(fields->values);
  fields->handles = NULL;
  fields->values = NULL;
  fields->count = 0;
}

int prepare_stored_field(napi_env env, napi_value descriptor, stored_field_handles *handles) {
  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, descriptor, &type) != napi_ok || type != napi_object) { return 0; }
  for (size_t region = 0; region < STORED_FIELD_REGIONS; region++) {
    if (napi_get_named_property(env, descriptor, FIELD_PROPERTIES[region], &handles->regions[region]) != napi_ok) {
      return 0;
    }
  }
  return 1;
}

narsil_status prepare_stored_fields(napi_env env, napi_value array, stored_fields *fields) {
  bool is_array = false;
  if (napi_is_array(env, array, &is_array) != napi_ok || !is_array ||
      napi_get_array_length(env, array, &fields->count) != napi_ok) {
    return NARSIL_INVALID_ARGUMENT;
  }
  if (fields->count == 0) { return NARSIL_OK; }
  size_t count = fields->count;
  if (count > SIZE_MAX / sizeof *fields->handles || count > SIZE_MAX / sizeof *fields->values) {
    return NARSIL_INVALID_ARGUMENT;
  }
  fields->handles = calloc(count, sizeof *fields->handles);
  fields->values = calloc(count, sizeof *fields->values);
  if (fields->handles == NULL || fields->values == NULL) { return NARSIL_OUT_OF_MEMORY; }
  for (uint32_t field = 0; field < fields->count; field++) {
    napi_value descriptor = NULL;
    if (napi_get_element(env, array, field, &descriptor) != napi_ok ||
        !prepare_stored_field(env, descriptor, &fields->handles[field])) {
      return NARSIL_INVALID_ARGUMENT;
    }
  }
  return NARSIL_OK;
}

int read_stored_field(napi_env env, const stored_field_handles *handles, narsil_stored_values *values) {
  void *data[STORED_FIELD_REGIONS] = {0};
  size_t lengths[STORED_FIELD_REGIONS] = {0};
  for (size_t region = 0; region < STORED_FIELD_REGIONS; region++) {
    if (!possibly_empty_typed_data(env, handles->regions[region], FIELD_TYPES[region], &data[region],
                                   &lengths[region])) {
      return 0;
    }
  }
  *values = (narsil_stored_values){
      data[SHAPES],  lengths[SHAPES],  data[STARTS],     lengths[STARTS],     data[KINDS],       lengths[KINDS],
      data[NUMBERS], lengths[NUMBERS], data[TEXT_START], lengths[TEXT_START], data[TEXT_LENGTH], lengths[TEXT_LENGTH],
      data[UNITS],   lengths[UNITS],   data[BYTES],      lengths[BYTES],
  };
  return 1;
}

int read_stored_fields(napi_env env, stored_fields *fields) {
  for (uint32_t field = 0; field < fields->count; field++) {
    if (!read_stored_field(env, &fields->handles[field], &fields->values[field])) { return 0; }
  }
  return 1;
}
