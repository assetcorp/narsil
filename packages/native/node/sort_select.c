#include "sort_values.h"

#include "../include/narsil_core.h"
#include "../include/narsil_sort_order.h"
#include "../include/narsil_sort_select.h"
#include "values.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <math.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

enum { COLUMNS, DIRECTIONS, FILTER, LIVE, LIMIT, ANCHOR_RANKS, ANCHOR_VALUES, OUTPUT, ARGUMENT_COUNT };
enum { CURRENT, VALUES, RANKS, ORDERED, DIRTY, COLUMN_FIELDS };
static const char *const PROPERTIES[COLUMN_FIELDS] = {"current", "values", "ranks", "ordered", "dirty"};

typedef struct {
  napi_value fields[COLUMN_FIELDS];
  sort_field_handles current;
  sort_field_handles values;
} column_handles;

static int prepare_column(napi_env env, napi_value descriptor, column_handles *handles) {
  napi_valuetype type;
  if (napi_typeof(env, descriptor, &type) != napi_ok || type != napi_object) { return 0; }
  for (size_t field = 0; field < COLUMN_FIELDS; field++) {
    if (napi_get_named_property(env, descriptor, PROPERTIES[field], &handles->fields[field]) != napi_ok) { return 0; }
  }
  return prepare_sort_field(env, handles->fields[CURRENT], &handles->current) &&
         prepare_sort_field(env, handles->fields[VALUES], &handles->values);
}

static int read_column(napi_env env, const column_handles *handles, narsil_sort_column *column) {
  void *ranks = NULL;
  void *ordered = NULL;
  void *dirty = NULL;
  if (!read_sort_field(env, &handles->current, &column->current) ||
      !read_sort_field(env, &handles->values, &column->values) ||
      !possibly_empty_typed_data(env, handles->fields[RANKS], napi_int32_array, &ranks, &column->rank_count) ||
      !possibly_empty_typed_data(env, handles->fields[ORDERED], napi_uint32_array, &ordered, &column->ordered_count) ||
      !possibly_empty_typed_data(env, handles->fields[DIRTY], napi_uint32_array, &dirty, &column->dirty_words)) {
    return 0;
  }
  column->ranks = ranks;
  column->ordered = ordered;
  column->dirty = dirty;
  return 1;
}

static narsil_status select_values(napi_env env, napi_value *argv, thread_state *state, uint32_t columns_count,
                                   column_handles *handles, uint32_t limit, narsil_sort_column *columns,
                                   uint32_t *count) {
  for (uint32_t field = 0; field < columns_count; field++) {
    napi_value descriptor;
    if (napi_get_element(env, argv[COLUMNS], field, &descriptor) != napi_ok ||
        !prepare_column(env, descriptor, &handles[field])) {
      return NARSIL_INVALID_ARGUMENT;
    }
  }
  napi_valuetype anchor_type;
  napi_valuetype rank_type;
  sort_field_handles anchor_handles = {0};
  if (napi_typeof(env, argv[ANCHOR_VALUES], &anchor_type) != napi_ok ||
      napi_typeof(env, argv[ANCHOR_RANKS], &rank_type) != napi_ok ||
      ((anchor_type == napi_null) != (rank_type == napi_null)) ||
      (anchor_type != napi_null && !prepare_sort_field(env, argv[ANCHOR_VALUES], &anchor_handles))) {
    return NARSIL_INVALID_ARGUMENT;
  }
  for (uint32_t field = 0; field < columns_count; field++) {
    if (!read_column(env, &handles[field], &columns[field])) { return NARSIL_INVALID_ARGUMENT; }
  }
  narsil_sort_select_request request = {0};
  narsil_sort_values anchor = {0};
  void *anchor_ranks = NULL;
  if (anchor_type != napi_null) {
    if (!read_sort_field(env, &anchor_handles, &anchor) ||
        !possibly_empty_typed_data(env, argv[ANCHOR_RANKS], napi_int32_array, &anchor_ranks,
                                   &request.anchor_rank_count)) {
      return NARSIL_INVALID_ARGUMENT;
    }
    request.anchor_values = &anchor;
    request.anchor_ranks = anchor_ranks;
  }
  void *directions = NULL;
  void *filter = NULL;
  void *live = NULL;
  void *output = NULL;
  if (!possibly_empty_typed_data(env, argv[DIRECTIONS], napi_uint8_array, &directions, &request.direction_count) ||
      !possibly_empty_typed_data(env, argv[FILTER], napi_uint32_array, &filter, &request.filter_words) ||
      !possibly_empty_typed_data(env, argv[LIVE], napi_uint32_array, &live, &request.live_words) ||
      !possibly_empty_typed_data(env, argv[OUTPUT], napi_uint32_array, &output, &request.output_capacity)) {
    return NARSIL_INVALID_ARGUMENT;
  }
  request.columns = columns;
  request.column_count = columns_count;
  request.directions = directions;
  request.filter = filter;
  request.live = live;
  request.limit = limit;
  request.output = output;
  return narsil_sort_select(state->workspace, &request, count);
}

napi_value sort_select(napi_env env, napi_callback_info info) {
  napi_value argv[ARGUMENT_COUNT];
  thread_state *state = thread_state_of(env);
  uint32_t length = 0;
  double limit = 0;
  bool array = false;
  if (state == NULL || !callback_arguments(env, info, ARGUMENT_COUNT, argv) ||
      napi_is_array(env, argv[COLUMNS], &array) != napi_ok || !array ||
      napi_get_array_length(env, argv[COLUMNS], &length) != napi_ok || length == 0 ||
      napi_get_value_double(env, argv[LIMIT], &limit) != napi_ok || !isfinite(limit) || limit < 0 ||
      limit > UINT32_MAX || limit != floor(limit)) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  size_t allocation_count = length;
  if (allocation_count > SIZE_MAX / sizeof(column_handles) ||
      allocation_count > SIZE_MAX / sizeof(narsil_sort_column)) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  column_handles *handles = calloc(length, sizeof *handles);
  narsil_sort_column *columns = calloc(length, sizeof *columns);
  if (handles == NULL || columns == NULL) {
    free(handles);
    free(columns);
    return number_of(env, -NARSIL_OUT_OF_MEMORY);
  }
  uint32_t count = 0;
  narsil_status status = select_values(env, argv, state, length, handles, (uint32_t)limit, columns, &count);
  free(handles);
  free(columns);
  report_workspace_memory(env, state);
  napi_value result = NULL;
  if (napi_create_double(env, status == NARSIL_OK ? (double)count : -(double)status, &result) != napi_ok) {
    return NULL;
  }
  return result;
}
