#include "expansion.h"

#include "../include/narsil_core.h"
#include "../include/narsil_expansion.h"
#include "frozen_segments.h"
#include "segments.h"
#include "values.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

enum { SOURCES, TYPED, STEMMED, OWN, OUT_SEGMENTS, OUT_TOKENS, OUT_FACTORS, ARGUMENT_COUNT };

int prepare_expansion_source(napi_env env, napi_value value, expansion_handles *handles) {
  napi_value growing;
  napi_value frozen;
  napi_value state;
  napi_valuetype growing_type = napi_undefined;
  napi_valuetype frozen_type = napi_undefined;
  napi_valuetype state_type = napi_undefined;
  napi_valuetype occurrence_type = napi_undefined;
  if (napi_get_named_property(env, value, "growing", &growing) != napi_ok ||
      napi_get_named_property(env, value, "frozen", &frozen) != napi_ok ||
      napi_get_named_property(env, value, "state", &state) != napi_ok ||
      napi_get_named_property(env, value, "occurrences", &handles->occurrences) != napi_ok ||
      napi_typeof(env, handles->occurrences, &occurrence_type) != napi_ok ||
      napi_typeof(env, growing, &growing_type) != napi_ok || napi_typeof(env, frozen, &frozen_type) != napi_ok ||
      napi_typeof(env, state, &state_type) != napi_ok) {
    return 0;
  }
  handles->has_growing = growing_type != napi_null;
  handles->has_occurrences = occurrence_type != napi_undefined && occurrence_type != napi_null;
  if (handles->has_growing) {
    return !handles->has_occurrences && frozen_type == napi_null && state_type == napi_null &&
           prepare_segment(env, growing, &handles->growing);
  }
  return frozen_type == napi_object && state_type == napi_object &&
         prepare_frozen_segment(env, frozen, state, &handles->frozen);
}

int read_expansion_source(napi_env env, const expansion_handles *handles, expansion_storage *storage,
                          narsil_expansion_segment *source) {
  if (handles->has_growing) {
    if (!read_segment(env, &handles->growing, &storage->growing)) { return 0; }
    source->growing = &storage->growing.growing;
    return 1;
  }
  if (!read_frozen_segment(env, &handles->frozen, &storage->frozen)) { return 0; }
  source->frozen = &storage->frozen.segment;
  source->state = &storage->frozen.state;
  if (handles->has_occurrences) {
    void *data = NULL;
    if (!possibly_empty_typed_data(env, handles->occurrences, napi_float64_array, &data, &source->occurrence_count) ||
        source->occurrence_count != source->frozen->terms.count) {
      return 0;
    }
    source->occurrences = data;
  }
  return 1;
}

static narsil_status execute(napi_env env, thread_state *thread, const napi_value *argv,
                             const narsil_expansion_segment *sources, uint32_t source_count, uint32_t *count) {
  void *data[ARGUMENT_COUNT] = {0};
  size_t lengths[ARGUMENT_COUNT] = {0};
  for (size_t at = TYPED; at < ARGUMENT_COUNT; at++) {
    napi_typedarray_type type = at < OUT_SEGMENTS ? napi_uint16_array : napi_uint32_array;
    if (at == OUT_FACTORS) { type = napi_float64_array; }
    if (!possibly_empty_typed_data(env, argv[at], type, data + at, lengths + at)) { return NARSIL_INVALID_ARGUMENT; }
  }
  narsil_prefix_request request = {sources,       source_count,     data[TYPED], lengths[TYPED],
                                   data[STEMMED], lengths[STEMMED], data[OWN],   lengths[OWN]};
  narsil_expansion_output output = {data[OUT_SEGMENTS],  lengths[OUT_SEGMENTS], data[OUT_TOKENS],
                                    lengths[OUT_TOKENS], data[OUT_FACTORS],     lengths[OUT_FACTORS]};
  return narsil_expand_prefix(thread->workspace, &request, &output, count);
}

static napi_value prefix(napi_env env, napi_callback_info info) {
  napi_value argv[ARGUMENT_COUNT];
  thread_state *thread = thread_state_of(env);
  bool array = false;
  uint32_t length = 0;
  if (thread == NULL || !callback_arguments(env, info, ARGUMENT_COUNT, argv) ||
      napi_is_array(env, argv[SOURCES], &array) != napi_ok || !array ||
      napi_get_array_length(env, argv[SOURCES], &length) != napi_ok) {
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
  if (status == NARSIL_OK) { status = execute(env, thread, argv, sources, length, &count); }
  free(handles);
  free(storage);
  free(sources);
  report_workspace_memory(env, thread);
  return number_of(env, status == NARSIL_OK ? (int32_t)count : -(int32_t)status);
}

int define_expansion(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"expandPrefix", NULL, prefix, NULL, NULL, NULL, napi_default_method, NULL},
      {"expandPartialWords", NULL, expand_partial_words, NULL, NULL, NULL, napi_default_method, NULL},
      {"suggestTerms", NULL, suggest_terms, NULL, NULL, NULL, napi_default_method, NULL}};
  return napi_define_properties(env, exports, sizeof properties / sizeof properties[0], properties) == napi_ok;
}
