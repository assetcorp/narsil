#include "fusion.h"

#include "values.h"

#include "../include/narsil_core.h"
#include "../include/narsil_fusion.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <math.h>
#include <stddef.h>
#include <stdint.h>

enum {
  FUSE_STRATEGY,
  FUSE_K,
  FUSE_ALPHA,
  FUSE_TEXT_KEYS,
  FUSE_TEXT_SCORES,
  FUSE_VECTOR_KEYS,
  FUSE_VECTOR_SCORES,
  FUSE_ID_RANKS,
  FUSE_OUTPUT_KEYS,
  FUSE_OUTPUT_SCORES,
  FUSE_ARGUMENT_COUNT
};

static int read_leg(napi_env env, napi_value keys_value, napi_value scores_value, narsil_fusion_leg *leg) {
  void *keys = NULL;
  void *scores = NULL;
  size_t key_count = 0;
  size_t score_count = 0;
  if (!possibly_empty_typed_data(env, keys_value, napi_uint32_array, &keys, &key_count) ||
      !possibly_empty_typed_data(env, scores_value, napi_float64_array, &scores, &score_count) ||
      key_count != score_count || key_count > UINT32_MAX) {
    return 0;
  }
  leg->keys = keys;
  leg->scores = scores;
  leg->count = (uint32_t)key_count;
  return 1;
}

static napi_value fuse(napi_env env, napi_callback_info info) {
  napi_value argv[FUSE_ARGUMENT_COUNT];
  narsil_fusion_request request = {0};
  double strategy = 0;
  void *ranks = NULL;
  void *keys = NULL;
  void *scores = NULL;
  size_t rank_count = 0;
  size_t key_capacity = 0;
  size_t score_capacity = 0;
  thread_state *state = thread_state_of(env);
  if (state == NULL || !callback_arguments(env, info, FUSE_ARGUMENT_COUNT, argv) ||
      napi_get_value_double(env, argv[FUSE_STRATEGY], &strategy) != napi_ok || !isfinite(strategy) ||
      strategy < (double)NARSIL_FUSION_RRF || strategy > (double)NARSIL_FUSION_LINEAR || strategy != floor(strategy) ||
      napi_get_value_double(env, argv[FUSE_K], &request.rank_constant) != napi_ok ||
      napi_get_value_double(env, argv[FUSE_ALPHA], &request.alpha) != napi_ok ||
      !read_leg(env, argv[FUSE_TEXT_KEYS], argv[FUSE_TEXT_SCORES], &request.text) ||
      !read_leg(env, argv[FUSE_VECTOR_KEYS], argv[FUSE_VECTOR_SCORES], &request.vector) ||
      !possibly_empty_typed_data(env, argv[FUSE_ID_RANKS], napi_uint32_array, &ranks, &rank_count) ||
      !possibly_empty_typed_data(env, argv[FUSE_OUTPUT_KEYS], napi_uint32_array, &keys, &key_capacity) ||
      !possibly_empty_typed_data(env, argv[FUSE_OUTPUT_SCORES], napi_float64_array, &scores, &score_capacity) ||
      rank_count > UINT32_MAX || key_capacity > UINT32_MAX || score_capacity > UINT32_MAX) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  request.strategy = (uint32_t)strategy;
  request.id_ranks = ranks;
  request.key_count = (uint32_t)rank_count;
  uint32_t capacity = (uint32_t)(key_capacity < score_capacity ? key_capacity : score_capacity);
  narsil_fusion_output output = {keys, scores, capacity, 0};
  narsil_status status = narsil_fuse(state->workspace, &request, &output);
  report_workspace_memory(env, state);
  if (status != NARSIL_OK) { return number_of(env, -(int32_t)status); }
  napi_value result = NULL;
  if (napi_create_uint32(env, output.count, &result) != napi_ok) { return NULL; }
  return result;
}

int define_fusion(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"fuse", NULL, fuse, NULL, NULL, NULL, napi_default_method, NULL},
  };
  return napi_define_properties(env, exports, sizeof properties / sizeof properties[0], properties) == napi_ok;
}
