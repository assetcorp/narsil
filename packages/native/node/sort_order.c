#include "sort_values.h"

#include "../include/narsil_core.h"
#include "../include/narsil_sort_order.h"
#include "values.h"

#include <js_native_api_types.h>
#include <stddef.h>
#include <stdint.h>

enum { CURRENT, LIVE, VALUES, RANKS, ORDERED, DIRTY, COUNTS, ARGUMENT_COUNT };

napi_value build_sort_order(napi_env env, napi_callback_info info) {
  napi_value argv[ARGUMENT_COUNT];
  sort_field_handles current_handles = {0};
  sort_field_handles output_handles = {0};
  thread_state *state = thread_state_of(env);
  if (state == NULL || !callback_arguments(env, info, ARGUMENT_COUNT, argv) ||
      !prepare_sort_field(env, argv[CURRENT], &current_handles) ||
      !prepare_sort_field(env, argv[VALUES], &output_handles)) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  narsil_sort_values current = {0};
  narsil_sort_order_output output = {0};
  void *live = NULL;
  void *ranks = NULL;
  void *ordered = NULL;
  void *dirty = NULL;
  void *counts = NULL;
  size_t live_words = 0;
  if (!read_sort_field(env, &current_handles, &current) ||
      !read_sort_field_output(env, &output_handles, &output.values) ||
      !possibly_empty_typed_data(env, argv[LIVE], napi_uint32_array, &live, &live_words) ||
      !possibly_empty_typed_data(env, argv[RANKS], napi_int32_array, &ranks, &output.rank_capacity) ||
      !possibly_empty_typed_data(env, argv[ORDERED], napi_uint32_array, &ordered, &output.ordered_capacity) ||
      !possibly_empty_typed_data(env, argv[DIRTY], napi_uint32_array, &dirty, &output.dirty_capacity) ||
      !possibly_empty_typed_data(env, argv[COUNTS], napi_uint32_array, &counts, &output.count_capacity)) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  output.ranks = ranks;
  output.ordered = ordered;
  output.dirty = dirty;
  output.counts = counts;
  narsil_status status = narsil_build_sort_order(state->workspace, &current, live, live_words, &output);
  report_workspace_memory(env, state);
  return number_of(env, -(int32_t)status);
}
