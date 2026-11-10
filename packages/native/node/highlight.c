#include "highlight.h"

#include "../include/narsil_analysis.h"
#include "../include/narsil_core.h"
#include "../include/narsil_highlight.h"
#include "segments.h"
#include "values.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <stddef.h>
#include <stdint.h>

enum { LANGUAGE, TEXT, QUERY, PRE_TAG, POST_TAG, MAXIMUM, SNIPPET, POSITIONS, LENGTH, ARGUMENT_COUNT };

static narsil_status execute(napi_env env, thread_state *thread, const napi_value *argv, highlight_handles *handles,
                             narsil_highlight_request *request, uint32_t *count) {
  void *snippet = NULL;
  void *positions = NULL;
  void *length = NULL;
  size_t snippet_capacity = 0;
  size_t position_words = 0;
  size_t length_words = 0;
  if (!read_highlight_query(env, handles) || !read_highlight_text(env, argv[TEXT], &request->text) ||
      !read_highlight_text(env, argv[PRE_TAG], &request->pre_tag) ||
      !read_highlight_text(env, argv[POST_TAG], &request->post_tag) ||
      !possibly_empty_typed_data(env, argv[SNIPPET], napi_uint16_array, &snippet, &snippet_capacity) ||
      !possibly_empty_typed_data(env, argv[POSITIONS], napi_uint32_array, &positions, &position_words) ||
      !possibly_empty_typed_data(env, argv[LENGTH], napi_uint32_array, &length, &length_words)) {
    return NARSIL_INVALID_ARGUMENT;
  }
  request->query = handles->query;
  narsil_highlight_output output = {snippet, snippet_capacity, positions, position_words, length, length_words};
  return narsil_highlight(thread->analyser, thread->workspace, request, &output, count);
}

static napi_value highlight(napi_env env, napi_callback_info info) {
  napi_value argv[ARGUMENT_COUNT];
  thread_state *thread = thread_state_of(env);
  narsil_highlight_request request = {0};
  if (thread == NULL || !callback_arguments(env, info, ARGUMENT_COUNT, argv) ||
      !segment_uint_argument(env, argv[LANGUAGE], &request.language) ||
      !segment_uint_argument(env, argv[MAXIMUM], &request.maximum)) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  highlight_handles handles = {0};
  narsil_status status = prepare_highlight_query(env, argv[QUERY], &handles) ? NARSIL_OK : NARSIL_INVALID_ARGUMENT;
  if (status == NARSIL_OK && thread->analyser == NULL) { status = narsil_analyser_create(&thread->analyser); }
  uint32_t count = 0;
  if (status == NARSIL_OK) { status = execute(env, thread, argv, &handles, &request, &count); }
  release_highlight_query(&handles);
  report_workspace_memory(env, thread);
  if (status != NARSIL_OK) { return number_of(env, -(int32_t)status); }
  napi_value result;
  return napi_create_uint32(env, count, &result) == napi_ok ? result : NULL;
}

int define_highlight(napi_env env, napi_value exports) {
  napi_property_descriptor property = {"highlight", NULL, highlight, NULL, NULL, NULL, napi_default_method, NULL};
  return napi_define_properties(env, exports, 1, &property) == napi_ok;
}
