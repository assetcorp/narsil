#include "../include/narsil_core.h"
#include "../include/narsil_expansion.h"
#include "../include/narsil_suggestions.h"
#include "expansion.h"
#include "segments.h"
#include "values.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

enum { SOURCES, TYPED, STEMMED, LIMIT, TERMS, STARTS, SPELLINGS, OCCURRENCES, ARGUMENT_COUNT };

static narsil_status execute(napi_env env, thread_state *thread, const napi_value *argv,
                             const narsil_expansion_segment *sources, uint32_t source_count, uint32_t limit,
                             uint32_t *count) {
  void *data[ARGUMENT_COUNT] = {0};
  size_t lengths[ARGUMENT_COUNT] = {0};
  for (size_t at = TYPED; at < ARGUMENT_COUNT; at++) {
    if (at == LIMIT) { continue; }
    napi_typedarray_type type = at < LIMIT ? napi_uint16_array : napi_uint32_array;
    if (at == OCCURRENCES) { type = napi_float64_array; }
    if (!possibly_empty_typed_data(env, argv[at], type, data + at, lengths + at)) { return NARSIL_INVALID_ARGUMENT; }
  }
  narsil_suggestion_request request = {sources,       source_count,     data[TYPED], lengths[TYPED],
                                       data[STEMMED], lengths[STEMMED], limit};
  narsil_suggestion_output output = {data[TERMS],     lengths[TERMS],     data[STARTS],      lengths[STARTS],
                                     data[SPELLINGS], lengths[SPELLINGS], data[OCCURRENCES], lengths[OCCURRENCES]};
  return narsil_suggest_terms(thread->workspace, &request, &output, count);
}

napi_value suggest_terms(napi_env env, napi_callback_info info) {
  napi_value argv[ARGUMENT_COUNT];
  thread_state *thread = thread_state_of(env);
  bool array = false;
  uint32_t length = 0;
  uint32_t limit = 0;
  if (thread == NULL || !callback_arguments(env, info, ARGUMENT_COUNT, argv) ||
      napi_is_array(env, argv[SOURCES], &array) != napi_ok || !array ||
      napi_get_array_length(env, argv[SOURCES], &length) != napi_ok ||
      !segment_uint_argument(env, argv[LIMIT], &limit)) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  size_t allocated = length == 0 ? 1 : length;
  if (allocated > SIZE_MAX / sizeof(expansion_handles) || allocated > SIZE_MAX / sizeof(expansion_storage) ||
      allocated > SIZE_MAX / sizeof(narsil_expansion_segment)) {
    return number_of(env, -NARSIL_OUT_OF_MEMORY);
  }
  expansion_handles *handles = calloc(allocated, sizeof *handles);
  expansion_storage *storage = calloc(allocated, sizeof *storage);
  narsil_expansion_segment *sources = calloc(allocated, sizeof *sources);
  narsil_status status = handles == NULL || storage == NULL || sources == NULL ? NARSIL_OUT_OF_MEMORY : NARSIL_OK;
  for (uint32_t at = 0; status == NARSIL_OK && at < length; at++) {
    napi_value value;
    if (napi_get_element(env, argv[SOURCES], at, &value) != napi_ok ||
        !prepare_expansion_source(env, value, handles + at)) {
      status = NARSIL_INVALID_ARGUMENT;
    }
  }
  for (uint32_t at = 0; status == NARSIL_OK && at < length; at++) {
    if (!read_expansion_source(env, handles + at, storage + at, sources + at)) { status = NARSIL_INVALID_ARGUMENT; }
  }
  uint32_t count = 0;
  if (status == NARSIL_OK) { status = execute(env, thread, argv, sources, length, limit, &count); }
  free(handles);
  free(storage);
  free(sources);
  report_workspace_memory(env, thread);
  if (status != NARSIL_OK) { return number_of(env, -(int32_t)status); }
  napi_value result;
  return napi_create_uint32(env, count, &result) == napi_ok ? result : NULL;
}
