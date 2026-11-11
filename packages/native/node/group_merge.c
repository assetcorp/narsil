#include "group_merge.h"

#include "values.h"

#include "../include/narsil_core.h"
#include "../include/narsil_group_merge.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <math.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

enum {
  GROUP_KEYS,
  GROUP_OFFSETS,
  GROUP_SCORES,
  GROUP_PRESENT,
  GROUP_RANKS,
  GROUP_ID_RANKS,
  GROUP_SORTED,
  GROUP_MAXIMUM,
  GROUP_LIMIT,
  GROUP_OUT_KEYS,
  GROUP_OUT_OFFSETS,
  GROUP_OUT_SOURCES,
  GROUP_OUT_INDICES,
  GROUP_ARGUMENT_COUNT
};

static int nullable_array(napi_env env, napi_value value, napi_typedarray_type type, void **data, size_t *length,
                          uint32_t *present) {
  napi_valuetype value_type = napi_undefined;
  if (napi_typeof(env, value, &value_type) != napi_ok) { return 0; }
  *present = value_type != napi_null;
  return *present == 0 || possibly_empty_typed_data(env, value, type, data, length);
}

static int unsigned_value(napi_env env, napi_value value, uint32_t *out) {
  double number = 0;
  if (napi_get_value_double(env, value, &number) != napi_ok || !isfinite(number) || number < 0 || number > UINT32_MAX ||
      number != floor(number)) {
    return 0;
  }
  *out = (uint32_t)number;
  return 1;
}

static napi_value merge_groups(napi_env env, napi_callback_info info) {
  napi_value argv[GROUP_ARGUMENT_COUNT];
  narsil_group_merge_request request = {0};
  narsil_group_merge_output output = {0};
  void *keys = NULL;
  void *offsets = NULL;
  void *scores = NULL;
  void *present = NULL;
  void *ranks = NULL;
  void *id_ranks = NULL;
  void *out_keys = NULL;
  void *out_offsets = NULL;
  void *out_sources = NULL;
  void *out_indices = NULL;
  bool sorted = false;
  napi_valuetype limit_type = napi_undefined;
  thread_state *state = thread_state_of(env);
  if (state == NULL || !callback_arguments(env, info, GROUP_ARGUMENT_COUNT, argv) ||
      !possibly_empty_typed_data(env, argv[GROUP_KEYS], napi_uint32_array, &keys, &request.key_count) ||
      !possibly_empty_typed_data(env, argv[GROUP_OFFSETS], napi_uint32_array, &offsets, &request.offset_count) ||
      !nullable_array(env, argv[GROUP_SCORES], napi_float64_array, &scores, &request.score_count,
                      &request.has_scores) ||
      !nullable_array(env, argv[GROUP_PRESENT], napi_uint32_array, &present, &request.score_present_count,
                      &request.has_score_present) ||
      !possibly_empty_typed_data(env, argv[GROUP_RANKS], napi_uint32_array, &ranks, &request.rank_count) ||
      !possibly_empty_typed_data(env, argv[GROUP_ID_RANKS], napi_uint32_array, &id_ranks, &request.id_rank_count) ||
      napi_get_value_bool(env, argv[GROUP_SORTED], &sorted) != napi_ok ||
      !unsigned_value(env, argv[GROUP_MAXIMUM], &request.max_per_group) ||
      napi_typeof(env, argv[GROUP_LIMIT], &limit_type) != napi_ok ||
      !possibly_empty_typed_data(env, argv[GROUP_OUT_KEYS], napi_uint32_array, &out_keys, &output.key_capacity) ||
      !possibly_empty_typed_data(env, argv[GROUP_OUT_OFFSETS], napi_uint32_array, &out_offsets,
                                 &output.offset_capacity) ||
      !possibly_empty_typed_data(env, argv[GROUP_OUT_SOURCES], napi_uint32_array, &out_sources,
                                 &output.source_capacity) ||
      !possibly_empty_typed_data(env, argv[GROUP_OUT_INDICES], napi_uint32_array, &out_indices,
                                 &output.index_capacity)) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  request.has_limit = limit_type != napi_null;
  if (request.has_limit != 0 && !unsigned_value(env, argv[GROUP_LIMIT], &request.limit)) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  request.keys = keys;
  request.offsets = offsets;
  request.scores = scores;
  request.score_present = present;
  request.ranks = ranks;
  request.id_ranks = id_ranks;
  request.sorted = (uint32_t)sorted;
  output.keys = out_keys;
  output.offsets = out_offsets;
  output.sources = out_sources;
  output.indices = out_indices;
  narsil_status status = narsil_merge_groups(state->workspace, &request, &output);
  report_workspace_memory(env, state);
  if (status != NARSIL_OK) { return number_of(env, -(int32_t)status); }
  napi_value result = NULL;
  if (napi_create_uint32(env, output.count, &result) != napi_ok) { return NULL; }
  return result;
}

int define_group_merge(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"mergeGroups", NULL, merge_groups, NULL, NULL, NULL, napi_default_method, NULL},
  };
  return napi_define_properties(env, exports, sizeof properties / sizeof properties[0], properties) == napi_ok;
}
