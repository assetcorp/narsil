#include "sort_values.h"

#include "../include/narsil_core.h"
#include "../include/narsil_sort_order.h"
#include "values.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

enum { COLUMN, LOWER, LOWER_INCLUSIVE, UPPER, UPPER_INCLUSIVE, LIVE, OUTPUT, ARGUMENT_COUNT };
enum { CURRENT, VALUES, RANKS, ORDERED, DIRTY, COLUMN_FIELDS };
static const char *const PROPERTIES[COLUMN_FIELDS] = {"current", "values", "ranks", "ordered", "dirty"};

static int read_bound(napi_env env, napi_value input, narsil_sort_bound *bound) {
  napi_valuetype type;
  if (napi_typeof(env, input, &type) != napi_ok) { return 0; }
  if (type == napi_null) { return 1; }
  void *units = NULL;
  if (!possibly_empty_typed_data(env, input, napi_uint16_array, &units, &bound->length)) { return 0; }
  bound->present = 1;
  bound->units = units;
  return 1;
}

napi_value text_range(napi_env env, napi_callback_info info) {
  napi_value argv[ARGUMENT_COUNT];
  napi_value fields[COLUMN_FIELDS];
  napi_valuetype type;
  bool lower_inclusive = false;
  bool upper_inclusive = false;
  if (!callback_arguments(env, info, ARGUMENT_COUNT, argv) || napi_typeof(env, argv[COLUMN], &type) != napi_ok ||
      type != napi_object || napi_get_value_bool(env, argv[LOWER_INCLUSIVE], &lower_inclusive) != napi_ok ||
      napi_get_value_bool(env, argv[UPPER_INCLUSIVE], &upper_inclusive) != napi_ok) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  for (size_t field = 0; field < COLUMN_FIELDS; field++) {
    if (napi_get_named_property(env, argv[COLUMN], PROPERTIES[field], &fields[field]) != napi_ok) {
      return number_of(env, -NARSIL_INVALID_ARGUMENT);
    }
  }
  sort_field_handles current = {0};
  sort_field_handles values = {0};
  if (!prepare_sort_field(env, fields[CURRENT], &current) || !prepare_sort_field(env, fields[VALUES], &values)) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  narsil_sort_column column = {0};
  narsil_text_range_request request = {0};
  request.lower.inclusive = (uint32_t)lower_inclusive;
  request.upper.inclusive = (uint32_t)upper_inclusive;
  void *ranks = NULL;
  void *ordered = NULL;
  void *dirty = NULL;
  void *live = NULL;
  void *output = NULL;
  if (!read_sort_field(env, &current, &column.current) || !read_sort_field(env, &values, &column.values) ||
      !possibly_empty_typed_data(env, fields[RANKS], napi_int32_array, &ranks, &column.rank_count) ||
      !possibly_empty_typed_data(env, fields[ORDERED], napi_uint32_array, &ordered, &column.ordered_count) ||
      !possibly_empty_typed_data(env, fields[DIRTY], napi_uint32_array, &dirty, &column.dirty_words) ||
      !read_bound(env, argv[LOWER], &request.lower) || !read_bound(env, argv[UPPER], &request.upper) ||
      !possibly_empty_typed_data(env, argv[LIVE], napi_uint32_array, &live, &request.live_words) ||
      !possibly_empty_typed_data(env, argv[OUTPUT], napi_uint32_array, &output, &request.output_words)) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  column.ranks = ranks;
  column.ordered = ordered;
  column.dirty = dirty;
  request.live = live;
  request.output = output;
  return number_of(env, -(int32_t)narsil_text_range(&column, &request));
}
