#include "../include/narsil_analysis.h"
#include "../include/narsil_core.h"
#include "../include/narsil_expansion.h"
#include "../include/narsil_folding.h"
#include "expansion.h"
#include "folding.h"
#include "values.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

enum {
  FOLDED_SOURCES,
  FOLDED_TABLES,
  FOLDED_LANGUAGE,
  FOLDED_WORDS,
  FOLDED_TEXTS,
  FOLDED_STARTS,
  FOLDED_SEGMENTS,
  FOLDED_TOKENS,
  FOLDED_FACTORS,
  FOLDED_COUNT
};
enum { OUT_STARTS, OUT_SEGMENTS, OUT_TOKENS, OUT_FACTORS, FOLDED_OUTPUTS };

typedef struct {
  partial_handles *sources;
  expansion_storage *storage;
  narsil_expansion_segment *segments;
  narsil_frozen_runs *runs;
  const narsil_fold_table **tables;
  partial_word_handles *word_handles;
  narsil_partial_word *words;
  narsil_term *folded;
  uint32_t source_count;
  uint32_t word_count;
} folded_partial_inputs;

static void release_inputs(folded_partial_inputs *inputs) {
  free(inputs->sources);
  free(inputs->storage);
  free(inputs->segments);
  free(inputs->runs);
  free((void *)inputs->tables);
  free(inputs->word_handles);
  free(inputs->words);
  free(inputs->folded);
}

static narsil_status allocate_inputs(folded_partial_inputs *inputs) {
  size_t sources = inputs->source_count == 0 ? 1 : inputs->source_count;
  size_t words = inputs->word_count == 0 ? 1 : inputs->word_count;
  if (sources > SIZE_MAX / sizeof(expansion_storage) || words > SIZE_MAX / sizeof(partial_word_handles)) {
    return NARSIL_OUT_OF_MEMORY;
  }
  inputs->sources = calloc(sources, sizeof *inputs->sources);
  inputs->storage = calloc(sources, sizeof *inputs->storage);
  inputs->segments = calloc(sources, sizeof *inputs->segments);
  inputs->runs = calloc(sources, sizeof *inputs->runs);
  inputs->tables = (const narsil_fold_table **)calloc(sources, sizeof *inputs->tables);
  inputs->word_handles = calloc(words, sizeof *inputs->word_handles);
  inputs->words = calloc(words, sizeof *inputs->words);
  inputs->folded = calloc(words, sizeof *inputs->folded);
  return inputs->sources == NULL || inputs->storage == NULL || inputs->segments == NULL || inputs->runs == NULL ||
                 inputs->tables == NULL || inputs->word_handles == NULL || inputs->words == NULL ||
                 inputs->folded == NULL
             ? NARSIL_OUT_OF_MEMORY
             : NARSIL_OK;
}

static narsil_status read_sources(napi_env env, napi_value list, folded_partial_inputs *inputs) {
  for (uint32_t at = 0; at < inputs->source_count; at++) {
    napi_value value;
    if (napi_get_element(env, list, at, &value) != napi_ok ||
        !prepare_partial_source(env, value, inputs->sources + at)) {
      return NARSIL_INVALID_ARGUMENT;
    }
  }
  for (uint32_t at = 0; at < inputs->source_count; at++) {
    if (!read_expansion_source(env, &inputs->sources[at].source, inputs->storage + at, inputs->segments + at) ||
        !read_partial_runs(env, inputs->sources + at, inputs->runs + at)) {
      return NARSIL_INVALID_ARGUMENT;
    }
  }
  return NARSIL_OK;
}

static narsil_status read_words(napi_env env, const napi_value *argv, folded_partial_inputs *inputs) {
  for (uint32_t at = 0; at < inputs->word_count; at++) {
    napi_value value;
    if (napi_get_element(env, argv[FOLDED_WORDS], at, &value) != napi_ok ||
        !prepare_partial_word(env, value, inputs->word_handles + at)) {
      return NARSIL_INVALID_ARGUMENT;
    }
  }
  for (uint32_t at = 0; at < inputs->word_count; at++) {
    napi_value value;
    void *units = NULL;
    size_t length = 0;
    if (!read_partial_word(env, inputs->word_handles + at, inputs->words + at) ||
        napi_get_element(env, argv[FOLDED_TEXTS], at, &value) != napi_ok ||
        !possibly_empty_typed_data(env, value, napi_uint16_array, &units, &length) || length > UINT32_MAX) {
      return NARSIL_INVALID_ARGUMENT;
    }
    inputs->folded[at] = (narsil_term){units, (uint32_t)length};
  }
  return NARSIL_OK;
}

static narsil_status run(napi_env env, thread_state *thread, const napi_value *argv, uint32_t *count) {
  folded_partial_inputs inputs = {0};
  uint32_t language = 0;
  uint32_t texts = 0;
  if (napi_get_value_uint32(env, argv[FOLDED_LANGUAGE], &language) != napi_ok ||
      !folded_array_length(env, argv[FOLDED_SOURCES], &inputs.source_count) ||
      !folded_array_length(env, argv[FOLDED_WORDS], &inputs.word_count) ||
      !folded_array_length(env, argv[FOLDED_TEXTS], &texts) || texts != inputs.word_count) {
    return NARSIL_INVALID_ARGUMENT;
  }
  narsil_status status = allocate_inputs(&inputs);
  if (status == NARSIL_OK) { status = read_sources(env, argv[FOLDED_SOURCES], &inputs); }
  if (status == NARSIL_OK) { status = read_words(env, argv, &inputs); }
  if (status == NARSIL_OK) {
    status = hold_fold_tables(env, thread, argv[FOLDED_TABLES], inputs.source_count, inputs.segments, language,
                              inputs.tables);
  }
  void *out[FOLDED_OUTPUTS] = {NULL, NULL, NULL, NULL};
  size_t lengths[FOLDED_OUTPUTS] = {0, 0, 0, 0};
  for (size_t at = 0; status == NARSIL_OK && at < FOLDED_OUTPUTS; at++) {
    napi_typedarray_type type = at == OUT_FACTORS ? napi_float64_array : napi_uint32_array;
    if (!possibly_empty_typed_data(env, argv[FOLDED_STARTS + at], type, out + at, lengths + at)) {
      status = NARSIL_INVALID_ARGUMENT;
    }
  }
  if (status == NARSIL_OK) {
    narsil_folded_partial_request request = {
        {inputs.segments, inputs.runs, inputs.source_count, inputs.words, inputs.word_count},
        inputs.tables,
        inputs.folded};
    narsil_partial_output output = {{out[OUT_SEGMENTS], lengths[OUT_SEGMENTS], out[OUT_TOKENS], lengths[OUT_TOKENS],
                                     out[OUT_FACTORS], lengths[OUT_FACTORS]},
                                    out[OUT_STARTS],
                                    lengths[OUT_STARTS]};
    status = narsil_expand_folded_partial_words(thread->workspace, &request, &output, count);
  }
  release_inputs(&inputs);
  return status;
}

napi_value expand_folded_partial_words(napi_env env, napi_callback_info info) {
  napi_value argv[FOLDED_COUNT];
  thread_state *thread = thread_state_of(env);
  if (thread == NULL || !callback_arguments(env, info, FOLDED_COUNT, argv)) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  uint32_t count = 0;
  narsil_status status = run(env, thread, argv, &count);
  report_workspace_memory(env, thread);
  return number_of(env, status == NARSIL_OK ? (int32_t)count : -(int32_t)status);
}
