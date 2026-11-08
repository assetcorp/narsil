#include "segments.h"

#include "../include/narsil_analysis.h"
#include "../include/narsil_core.h"
#include "../include/narsil_segments.h"
#include "segment_merge.h"
#include "values.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

enum { SEGMENT, ORDINAL, FIELDS, ARGUMENTS };
enum { STACK_FIELDS = 8, TOKEN_WORDS = sizeof(narsil_token) / sizeof(uint32_t) };

int prepare_segment_fields(napi_env env, napi_value list, field_handles *fields, uint32_t count) {
  for (uint32_t index = 0; index < count; index++) {
    napi_value field = NULL;
    napi_value ordinal = NULL;
    field_handles *handles = fields + index;
    if (napi_get_element(env, list, index, &field) != napi_ok ||
        napi_get_named_property(env, field, "field", &ordinal) != napi_ok ||
        !segment_uint_argument(env, ordinal, &handles->field) || handles->field > UINT16_MAX ||
        napi_get_named_property(env, field, "tokens", &handles->tokens) != napi_ok ||
        napi_get_named_property(env, field, "units", &handles->units) != napi_ok) {
      return 0;
    }
  }
  return 1;
}

int read_segment_fields(napi_env env, const field_handles *handles, narsil_field_tokens *fields, uint32_t count) {
  for (uint32_t index = 0; index < count; index++) {
    void *tokens = NULL;
    void *units = NULL;
    size_t words = 0;
    size_t text = 0;
    if (!possibly_empty_typed_data(env, handles[index].tokens, napi_uint32_array, &tokens, &words) ||
        !possibly_empty_typed_data(env, handles[index].units, napi_uint16_array, &units, &text) ||
        words % TOKEN_WORDS != 0 || words / TOKEN_WORDS > UINT32_MAX || text > UINT32_MAX) {
      return 0;
    }
    fields[index] = (narsil_field_tokens){(uint16_t)handles[index].field,
                                          {tokens, (uint32_t)(words / TOKEN_WORDS), units, (uint32_t)text}};
  }
  return 1;
}

static narsil_status index_fields(napi_env env, thread_state *state, const napi_value argv[ARGUMENTS], uint32_t count,
                                  field_handles *handles, narsil_field_tokens *fields, int removing) {
  segment_handles regions = {0};
  node_segment segment = {0};
  uint32_t ordinal = 0;
  if (!prepare_segment(env, argv[SEGMENT], &regions) || !segment_uint_argument(env, argv[ORDINAL], &ordinal) ||
      !prepare_segment_fields(env, argv[FIELDS], handles, count) || !read_segment(env, &regions, &segment) ||
      !read_segment_fields(env, handles, fields, count)) {
    return NARSIL_INVALID_ARGUMENT;
  }
  narsil_index_terms_request request = {&segment.growing, ordinal, fields, count};
  return removing ? narsil_remove_document(state->workspace, &request) : narsil_index_terms(state->workspace, &request);
}

static napi_value mutate_document(napi_env env, napi_callback_info info, int removing) {
  napi_value argv[ARGUMENTS];
  thread_state *state = thread_state_of(env);
  uint32_t count = 0;
  bool array = false;
  if (state == NULL || !callback_arguments(env, info, ARGUMENTS, argv) ||
      napi_is_array(env, argv[FIELDS], &array) != napi_ok || !array ||
      napi_get_array_length(env, argv[FIELDS], &count) != napi_ok || count > (uint32_t)UINT16_MAX + 1) {
    return status_of(env, NARSIL_INVALID_ARGUMENT);
  }
  field_handles local_handles[STACK_FIELDS] = {0};
  narsil_field_tokens local_fields[STACK_FIELDS] = {0};
  field_handles *handles = local_handles;
  narsil_field_tokens *fields = local_fields;
  if (count > STACK_FIELDS) {
    handles = calloc(count, sizeof *handles);
    fields = calloc(count, sizeof *fields);
    if (handles == NULL || fields == NULL) {
      free(handles);
      free(fields);
      return status_of(env, NARSIL_OUT_OF_MEMORY);
    }
  }
  narsil_status status = index_fields(env, state, argv, count, handles, fields, removing);
  if (count > STACK_FIELDS) {
    free(handles);
    free(fields);
  }
  report_workspace_memory(env, state);
  return status_of(env, status);
}

static napi_value index_terms(napi_env env, napi_callback_info info) { return mutate_document(env, info, 0); }

static napi_value remove_document(napi_env env, napi_callback_info info) { return mutate_document(env, info, 1); }

static napi_value batch(napi_env env, napi_callback_info info, int ending) {
  napi_value argv[1];
  thread_state *state = thread_state_of(env);
  segment_handles handles = {0};
  node_segment segment = {0};
  if (state == NULL || !callback_arguments(env, info, 1, argv) || !prepare_segment(env, argv[0], &handles) ||
      !read_segment(env, &handles, &segment)) {
    return status_of(env, NARSIL_INVALID_ARGUMENT);
  }
  narsil_status status = ending ? narsil_end_batch(state->workspace, &segment.growing)
                                : narsil_begin_batch(state->workspace, &segment.growing);
  report_workspace_memory(env, state);
  return status_of(env, status);
}

static napi_value begin_batch(napi_env env, napi_callback_info info) { return batch(env, info, 0); }
static napi_value end_batch(napi_env env, napi_callback_info info) { return batch(env, info, 1); }

int define_segments(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"indexTerms", NULL, index_terms, NULL, NULL, NULL, napi_default_method, NULL},
      {"removeDocument", NULL, remove_document, NULL, NULL, NULL, napi_default_method, NULL},
      {"removeFrozenDocument", NULL, remove_frozen_document, NULL, NULL, NULL, napi_default_method, NULL},
      {"prepareFrozenRemoval", NULL, prepare_frozen_removal, NULL, NULL, NULL, napi_default_method, NULL},
      {"beginBatch", NULL, begin_batch, NULL, NULL, NULL, napi_default_method, NULL},
      {"endBatch", NULL, end_batch, NULL, NULL, NULL, napi_default_method, NULL},
  };
  return napi_define_properties(env, exports, sizeof properties / sizeof properties[0], properties) == napi_ok &&
         define_segment_merges(env, exports) && define_field_merges(env, exports);
}
