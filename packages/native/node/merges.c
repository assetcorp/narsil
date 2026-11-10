#include "merges.h"

#include "values.h"

#include "../include/narsil_core.h"
#include "../include/narsil_merges.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <math.h>
#include <stddef.h>
#include <stdint.h>

enum { MERGE_OFFSETS, MERGE_SCORES, MERGE_RANKS, MERGE_LIMIT, MERGE_LISTS, MERGE_INDICES, MERGE_ARGUMENT_COUNT };

static napi_value merge(napi_env env, napi_callback_info info, int scored) {
  napi_value argv[MERGE_ARGUMENT_COUNT];
  size_t skipped = scored ? 0 : 1;
  narsil_merge_request request = {0};
  narsil_merge_output output = {0};
  void *offsets = NULL;
  void *scores = NULL;
  void *ranks = NULL;
  void *lists = NULL;
  void *indices = NULL;
  double limit = 0;
  thread_state *state = thread_state_of(env);
  if (state == NULL || !callback_arguments(env, info, MERGE_ARGUMENT_COUNT - skipped, argv) ||
      !possibly_empty_typed_data(env, argv[MERGE_OFFSETS], napi_uint32_array, &offsets, &request.offset_count) ||
      (scored &&
       !possibly_empty_typed_data(env, argv[MERGE_SCORES], napi_float64_array, &scores, &request.score_count)) ||
      !possibly_empty_typed_data(env, argv[MERGE_RANKS - skipped], napi_uint32_array, &ranks, &request.rank_count) ||
      napi_get_value_double(env, argv[MERGE_LIMIT - skipped], &limit) != napi_ok || !isfinite(limit) || limit < 0 ||
      limit > UINT32_MAX || limit != floor(limit) ||
      !possibly_empty_typed_data(env, argv[MERGE_LISTS - skipped], napi_uint32_array, &lists, &output.list_capacity) ||
      !possibly_empty_typed_data(env, argv[MERGE_INDICES - skipped], napi_uint32_array, &indices,
                                 &output.index_capacity)) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  request.offsets = offsets;
  request.scores = scores;
  request.ranks = ranks;
  request.limit = (uint32_t)limit;
  output.lists = lists;
  output.indices = indices;
  narsil_status status = NARSIL_OK;
  if (scored) {
    status = narsil_merge_rankings(state->workspace, &request, &output);
  } else {
    status = narsil_merge_sorted(state->workspace, &request, &output);
  }
  report_workspace_memory(env, state);
  if (status != NARSIL_OK) { return number_of(env, -(int32_t)status); }
  napi_value result = NULL;
  if (napi_create_uint32(env, output.count, &result) != napi_ok) { return NULL; }
  return result;
}

static napi_value merge_rankings(napi_env env, napi_callback_info info) { return merge(env, info, 1); }

static napi_value merge_sorted(napi_env env, napi_callback_info info) { return merge(env, info, 0); }

int define_merges(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"mergeRankings", NULL, merge_rankings, NULL, NULL, NULL, napi_default_method, NULL},
      {"mergeSorted", NULL, merge_sorted, NULL, NULL, NULL, napi_default_method, NULL},
  };
  return napi_define_properties(env, exports, sizeof properties / sizeof properties[0], properties) == napi_ok;
}
