#include "sort_values.h"

#include "../include/narsil_sort_order.h"
#include "values.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <stddef.h>

static const char *const PROPERTIES[SORT_FIELD_REGIONS] = {"kinds", "numbers", "textStart", "textLength", "units"};
static const napi_typedarray_type TYPES[SORT_FIELD_REGIONS] = {
    napi_uint8_array, napi_float64_array, napi_uint32_array, napi_uint32_array, napi_uint16_array,
};

int prepare_sort_field(napi_env env, napi_value descriptor, sort_field_handles *handles) {
  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, descriptor, &type) != napi_ok || type != napi_object) { return 0; }
  for (size_t region = 0; region < SORT_FIELD_REGIONS; region++) {
    if (napi_get_named_property(env, descriptor, PROPERTIES[region], &handles->regions[region]) != napi_ok) {
      return 0;
    }
  }
  return 1;
}

static int read_regions(napi_env env, const sort_field_handles *handles, void **data, size_t *lengths) {
  for (size_t region = 0; region < SORT_FIELD_REGIONS; region++) {
    if (!possibly_empty_typed_data(env, handles->regions[region], TYPES[region], &data[region], &lengths[region])) {
      return 0;
    }
  }
  return 1;
}

int read_sort_field(napi_env env, const sort_field_handles *handles, narsil_sort_values *values) {
  void *data[SORT_FIELD_REGIONS] = {0};
  size_t lengths[SORT_FIELD_REGIONS] = {0};
  if (!read_regions(env, handles, data, lengths)) { return 0; }
  *values = (narsil_sort_values){data[0],    lengths[0], data[1],    lengths[1], data[2],
                                 lengths[2], data[3],    lengths[3], data[4],    lengths[4]};
  return 1;
}

int read_sort_field_output(napi_env env, const sort_field_handles *handles, narsil_sort_values_output *values) {
  void *data[SORT_FIELD_REGIONS] = {0};
  size_t lengths[SORT_FIELD_REGIONS] = {0};
  if (!read_regions(env, handles, data, lengths)) { return 0; }
  *values = (narsil_sort_values_output){data[0],    lengths[0], data[1],    lengths[1], data[2],
                                        lengths[2], data[3],    lengths[3], data[4],    lengths[4]};
  return 1;
}
