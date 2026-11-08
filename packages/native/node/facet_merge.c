#include "facet_merge.h"

#include "values.h"

#include "../include/narsil_core.h"
#include "../include/narsil_facet_merge.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <math.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

enum {
  FACET_OFFSETS,
  FACET_VALUES,
  FACET_COUNTS,
  FACET_BOUNDS,
  FACET_RANKS,
  FACET_ASCENDING,
  FACET_LIMIT,
  FACET_OUT_VALUES,
  FACET_OUT_COUNTS,
  FACET_OUT_BOUND,
  FACET_ARGUMENT_COUNT
};

static napi_value merge_facets(napi_env env, napi_callback_info info) {
  napi_value argv[FACET_ARGUMENT_COUNT];
  narsil_facet_merge_request request = {0};
  narsil_facet_merge_output output = {0};
  void *offsets = NULL;
  void *values = NULL;
  void *counts = NULL;
  void *bounds = NULL;
  void *ranks = NULL;
  void *out_values = NULL;
  void *out_counts = NULL;
  void *out_bound = NULL;
  bool ascending = false;
  napi_valuetype limit_type = napi_undefined;
  thread_state *state = thread_state_of(env);
  if (state == NULL || !callback_arguments(env, info, FACET_ARGUMENT_COUNT, argv) ||
      !possibly_empty_typed_data(env, argv[FACET_OFFSETS], napi_uint32_array, &offsets, &request.offset_count) ||
      !possibly_empty_typed_data(env, argv[FACET_VALUES], napi_uint32_array, &values, &request.value_count) ||
      !possibly_empty_typed_data(env, argv[FACET_COUNTS], napi_uint32_array, &counts, &request.count_count) ||
      !possibly_empty_typed_data(env, argv[FACET_BOUNDS], napi_uint32_array, &bounds, &request.bound_count) ||
      !possibly_empty_typed_data(env, argv[FACET_RANKS], napi_uint32_array, &ranks, &request.rank_count) ||
      !possibly_empty_typed_data(env, argv[FACET_OUT_VALUES], napi_uint32_array, &out_values, &output.value_capacity) ||
      !possibly_empty_typed_data(env, argv[FACET_OUT_COUNTS], napi_uint32_array, &out_counts, &output.count_capacity) ||
      !possibly_empty_typed_data(env, argv[FACET_OUT_BOUND], napi_uint32_array, &out_bound, &output.bound_capacity) ||
      napi_get_value_bool(env, argv[FACET_ASCENDING], &ascending) != napi_ok ||
      napi_typeof(env, argv[FACET_LIMIT], &limit_type) != napi_ok) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  request.has_limit = limit_type != napi_null;
  if (request.has_limit != 0) {
    double limit = 0;
    if (napi_get_value_double(env, argv[FACET_LIMIT], &limit) != napi_ok || !isfinite(limit) || limit < 0 ||
        limit > UINT32_MAX || limit != floor(limit)) {
      return number_of(env, -NARSIL_INVALID_ARGUMENT);
    }
    request.limit = (uint32_t)limit;
  }
  request.offsets = offsets;
  request.values = values;
  request.counts = counts;
  request.bounds = bounds;
  request.ranks = ranks;
  request.ascending = (uint32_t)ascending;
  output.values = out_values;
  output.counts = out_counts;
  output.bound = out_bound;
  narsil_status status = narsil_merge_facets(state->workspace, &request, &output);
  report_workspace_memory(env, state);
  if (status != NARSIL_OK) { return number_of(env, -(int32_t)status); }
  napi_value result = NULL;
  if (napi_create_uint32(env, output.count, &result) != napi_ok) { return NULL; }
  return result;
}

int define_facet_merge(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"mergeFacets", NULL, merge_facets, NULL, NULL, NULL, napi_default_method, NULL},
      {"booleanFacet", NULL, boolean_facet, NULL, NULL, NULL, napi_default_method, NULL},
      {"numberFacet", NULL, number_facet, NULL, NULL, NULL, napi_default_method, NULL},
      {"rangeFacet", NULL, range_facet, NULL, NULL, NULL, napi_default_method, NULL},
      {"enumFacet", NULL, enum_facet, NULL, NULL, NULL, napi_default_method, NULL},
      {"valueFacet", NULL, value_facet, NULL, NULL, NULL, napi_default_method, NULL},
      {"storedRangeFacet", NULL, stored_range_facet, NULL, NULL, NULL, napi_default_method, NULL},
  };
  return napi_define_properties(env, exports, sizeof properties / sizeof properties[0], properties) == napi_ok;
}
