#include "expansion.h"

#include "../include/narsil_core.h"
#include "../include/narsil_expansion.h"
#include "segments.h"
#include "values.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

enum { SOURCES, WORDS, OUT_STARTS, OUT_SEGMENTS, OUT_TOKENS, OUT_FACTORS, ARGUMENT_COUNT };
enum { RUN_POINTS, RUN_OFFSETS, RUN_MEMBERS, RUN_REGIONS };
static const char *const RUN_PROPERTIES[RUN_REGIONS] = {"runs", "offsets", "members"};

typedef struct {
  expansion_handles source;
  napi_value runs[RUN_REGIONS];
  int has_runs;
} partial_handles;

typedef struct {
  napi_value written;
  napi_value own;
  uint32_t tolerance;
  uint32_t prefix_length;
} word_handles;

static int array_length(napi_env env, napi_value value, uint32_t *length) {
  bool array = false;
  return napi_is_array(env, value, &array) == napi_ok && array && napi_get_array_length(env, value, length) == napi_ok;
}

static int prepare_source(napi_env env, napi_value value, partial_handles *handles) {
  napi_value source;
  napi_value runs;
  napi_valuetype type;
  if (napi_get_named_property(env, value, "segment", &source) != napi_ok ||
      napi_get_named_property(env, value, "runs", &runs) != napi_ok ||
      !prepare_expansion_source(env, source, &handles->source) || napi_typeof(env, runs, &type) != napi_ok) {
    return 0;
  }
  handles->has_runs = type != napi_null;
  if (handles->has_runs) {
    if (type != napi_object || handles->source.has_growing) { return 0; }
    for (size_t at = 0; at < RUN_REGIONS; at++) {
      if (napi_get_named_property(env, runs, RUN_PROPERTIES[at], handles->runs + at) != napi_ok) { return 0; }
    }
  }
  return 1;
}

static int prepare_word(napi_env env, napi_value value, word_handles *handles) {
  napi_value tolerance;
  napi_value prefix;
  return napi_get_named_property(env, value, "written", &handles->written) == napi_ok &&
         napi_get_named_property(env, value, "own", &handles->own) == napi_ok &&
         napi_get_named_property(env, value, "tolerance", &tolerance) == napi_ok &&
         napi_get_named_property(env, value, "prefixLength", &prefix) == napi_ok &&
         segment_uint_argument(env, tolerance, &handles->tolerance) &&
         segment_uint_argument(env, prefix, &handles->prefix_length);
}

static int read_runs(napi_env env, const partial_handles *handles, narsil_frozen_runs *runs) {
  if (!handles->has_runs) { return 1; }
  void *data[RUN_REGIONS] = {0};
  size_t lengths[RUN_REGIONS] = {0};
  for (size_t at = 0; at < RUN_REGIONS; at++) {
    if (!possibly_empty_typed_data(env, handles->runs[at], napi_uint32_array, data + at, lengths + at)) { return 0; }
  }
  *runs = (narsil_frozen_runs){data[RUN_POINTS],     lengths[RUN_POINTS], data[RUN_OFFSETS],
                               lengths[RUN_OFFSETS], data[RUN_MEMBERS],   lengths[RUN_MEMBERS]};
  return 1;
}

static int read_word(napi_env env, const word_handles *handles, narsil_partial_word *word) {
  void *written = NULL;
  void *own = NULL;
  if (!possibly_empty_typed_data(env, handles->written, napi_uint16_array, &written, &word->written_length) ||
      !possibly_empty_typed_data(env, handles->own, napi_uint16_array, &own, &word->own_length)) {
    return 0;
  }
  word->written = written;
  word->own = own;
  word->tolerance = handles->tolerance;
  word->prefix_length = handles->prefix_length;
  return 1;
}

static narsil_status execute(napi_env env, thread_state *thread, const napi_value *argv,
                             const narsil_partial_request *request, uint32_t *count) {
  void *data[ARGUMENT_COUNT] = {0};
  size_t lengths[ARGUMENT_COUNT] = {0};
  for (size_t at = OUT_STARTS; at < ARGUMENT_COUNT; at++) {
    napi_typedarray_type type = at == OUT_FACTORS ? napi_float64_array : napi_uint32_array;
    if (!possibly_empty_typed_data(env, argv[at], type, data + at, lengths + at)) { return NARSIL_INVALID_ARGUMENT; }
  }
  narsil_partial_output output = {{data[OUT_SEGMENTS], lengths[OUT_SEGMENTS], data[OUT_TOKENS], lengths[OUT_TOKENS],
                                   data[OUT_FACTORS], lengths[OUT_FACTORS]},
                                  data[OUT_STARTS],
                                  lengths[OUT_STARTS]};
  return narsil_expand_partial_words(thread->workspace, request, &output, count);
}

static narsil_status prepare_inputs(napi_env env, const napi_value *argv, partial_handles *sources,
                                    uint32_t source_count, word_handles *words, uint32_t word_count) {
  for (uint32_t at = 0; at < source_count; at++) {
    napi_value value;
    if (napi_get_element(env, argv[SOURCES], at, &value) != napi_ok || !prepare_source(env, value, sources + at)) {
      return NARSIL_INVALID_ARGUMENT;
    }
  }
  for (uint32_t at = 0; at < word_count; at++) {
    napi_value value;
    if (napi_get_element(env, argv[WORDS], at, &value) != napi_ok || !prepare_word(env, value, words + at)) {
      return NARSIL_INVALID_ARGUMENT;
    }
  }
  return NARSIL_OK;
}

napi_value expand_partial_words(napi_env env, napi_callback_info info) {
  napi_value argv[ARGUMENT_COUNT];
  thread_state *thread = thread_state_of(env);
  uint32_t source_count = 0;
  uint32_t word_count = 0;
  if (thread == NULL || !callback_arguments(env, info, ARGUMENT_COUNT, argv) ||
      !array_length(env, argv[SOURCES], &source_count) || !array_length(env, argv[WORDS], &word_count)) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  size_t source_size = source_count == 0 ? 1 : source_count;
  size_t word_size = word_count == 0 ? 1 : word_count;
  if (source_size > SIZE_MAX / sizeof(partial_handles) || source_size > SIZE_MAX / sizeof(expansion_storage) ||
      source_size > SIZE_MAX / sizeof(narsil_expansion_segment) ||
      source_size > SIZE_MAX / sizeof(narsil_frozen_runs) || word_size > SIZE_MAX / sizeof(word_handles) ||
      word_size > SIZE_MAX / sizeof(narsil_partial_word)) {
    return number_of(env, -NARSIL_OUT_OF_MEMORY);
  }
  partial_handles *sources = calloc(source_size, sizeof *sources);
  expansion_storage *storage = calloc(source_size, sizeof *storage);
  narsil_expansion_segment *segments = calloc(source_size, sizeof *segments);
  narsil_frozen_runs *runs = calloc(source_size, sizeof *runs);
  word_handles *handles = calloc(word_size, sizeof *handles);
  narsil_partial_word *words = calloc(word_size, sizeof *words);
  narsil_status status =
      sources == NULL || storage == NULL || segments == NULL || runs == NULL || handles == NULL || words == NULL
          ? NARSIL_OUT_OF_MEMORY
          : NARSIL_OK;
  if (status == NARSIL_OK) { status = prepare_inputs(env, argv, sources, source_count, handles, word_count); }
  for (uint32_t at = 0; status == NARSIL_OK && at < source_count; at++) {
    if (!read_expansion_source(env, &sources[at].source, storage + at, segments + at) ||
        !read_runs(env, sources + at, runs + at)) {
      status = NARSIL_INVALID_ARGUMENT;
    }
  }
  for (uint32_t at = 0; status == NARSIL_OK && at < word_count; at++) {
    if (!read_word(env, handles + at, words + at)) { status = NARSIL_INVALID_ARGUMENT; }
  }
  uint32_t count = 0;
  narsil_partial_request request = {segments, runs, source_count, words, word_count};
  if (status == NARSIL_OK) { status = execute(env, thread, argv, &request, &count); }
  free(sources);
  free(storage);
  free(segments);
  free(runs);
  free(handles);
  free(words);
  report_workspace_memory(env, thread);
  return number_of(env, status == NARSIL_OK ? (int32_t)count : -(int32_t)status);
}
