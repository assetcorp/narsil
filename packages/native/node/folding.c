#include "folding.h"

#include "../include/narsil_analysis.h"
#include "../include/narsil_core.h"
#include "../include/narsil_expansion.h"
#include "../include/narsil_folding.h"
#include "expansion.h"
#include "segments.h"
#include "values.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

#define FOLD_TABLE_KIND 0x4E464C44U

enum { FOLDED_SOURCES_ARGUMENT, FOLDED_TABLES_ARGUMENT, FOLDED_LANGUAGE_ARGUMENT, FOLDED_SHARED_ARGUMENTS };
enum { TERMS_WORDS = FOLDED_SHARED_ARGUMENTS, TERMS_SEGMENTS, TERMS_TOKENS, TERMS_STARTS, TERMS_COUNT };
enum {
  PREFIX_TYPED = FOLDED_SHARED_ARGUMENTS,
  PREFIX_STEMMED,
  PREFIX_OWN,
  PREFIX_FOLDED,
  PREFIX_SEGMENTS,
  PREFIX_TOKENS,
  PREFIX_FACTORS,
  PREFIX_COUNT
};
enum {
  TERMS_OUTPUTS = TERMS_COUNT - TERMS_SEGMENTS,
  PREFIX_TEXTS = PREFIX_SEGMENTS - PREFIX_TYPED,
  PREFIX_OUTPUTS = PREFIX_COUNT - PREFIX_SEGMENTS
};

typedef struct {
  uint32_t kind;
  narsil_fold_table *table;
  int64_t reported_bytes;
} attached_fold_table;

typedef struct {
  expansion_handles *handles;
  expansion_storage *storage;
  narsil_expansion_segment *segments;
  const narsil_fold_table **tables;
  uint32_t count;
} folded_sources;

static void report_table_memory(napi_env env, attached_fold_table *attached, int64_t held) {
  int64_t adjusted = 0;
  if (held == attached->reported_bytes) { return; }
  if (napi_adjust_external_memory(env, held - attached->reported_bytes, &adjusted) == napi_ok) {
    attached->reported_bytes = held;
  }
}

static void release_fold_table(napi_env env, void *finalize_data, void *finalize_hint) {
  (void)finalize_hint;
  attached_fold_table *attached = finalize_data;
  report_table_memory(env, attached, 0);
  narsil_fold_table_destroy(attached->table);
  free(attached);
}

static napi_value create_fold_table(napi_env env, napi_callback_info info) {
  (void)info;
  attached_fold_table *attached = calloc(1, sizeof *attached);
  if (attached == NULL || narsil_fold_table_create(&attached->table) != NARSIL_OK) {
    free(attached);
    return throw_error(env, "createFoldTable cannot allocate a fold table");
  }
  attached->kind = FOLD_TABLE_KIND;
  napi_value handle = NULL;
  if (napi_create_external(env, attached, release_fold_table, NULL, &handle) != napi_ok) {
    release_fold_table(env, attached, NULL);
    return throw_error(env, "createFoldTable cannot create the fold table handle");
  }
  report_table_memory(env, attached, (int64_t)narsil_fold_table_bytes(attached->table));
  return handle;
}

int folded_array_length(napi_env env, napi_value value, uint32_t *length) {
  bool array = false;
  return napi_is_array(env, value, &array) == napi_ok && array && napi_get_array_length(env, value, length) == napi_ok;
}

static attached_fold_table *fold_table_of(napi_env env, napi_value value) {
  napi_valuetype type = napi_undefined;
  void *data = NULL;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_external ||
      napi_get_value_external(env, value, &data) != napi_ok || data == NULL) {
    return NULL;
  }
  attached_fold_table *attached = data;
  return attached->kind == FOLD_TABLE_KIND ? attached : NULL;
}

narsil_status hold_fold_tables(napi_env env, thread_state *thread, napi_value tables, uint32_t count,
                               const narsil_expansion_segment *segments, uint32_t language,
                               const narsil_fold_table **held) {
  uint32_t length = 0;
  if (!folded_array_length(env, tables, &length) || length != count) { return NARSIL_INVALID_ARGUMENT; }
  if (thread->analyser == NULL && narsil_analyser_create(&thread->analyser) != NARSIL_OK) {
    thread->analyser = NULL;
    return NARSIL_OUT_OF_MEMORY;
  }
  for (uint32_t at = 0; at < count; at++) {
    napi_value value;
    if (napi_get_element(env, tables, at, &value) != napi_ok) { return NARSIL_INVALID_ARGUMENT; }
    attached_fold_table *attached = fold_table_of(env, value);
    if (attached == NULL) { return NARSIL_INVALID_ARGUMENT; }
    narsil_status status =
        narsil_fold_table_update(thread->workspace, thread->analyser, attached->table, segments + at, language);
    report_table_memory(env, attached, (int64_t)narsil_fold_table_bytes(attached->table));
    if (status != NARSIL_OK) { return status; }
    held[at] = attached->table;
  }
  return NARSIL_OK;
}

static void release_sources(folded_sources *sources) {
  free(sources->handles);
  free(sources->storage);
  free(sources->segments);
  free((void *)sources->tables);
}

static narsil_status read_sources(napi_env env, thread_state *thread, const napi_value *argv, uint32_t language,
                                  folded_sources *sources) {
  napi_value list = argv[FOLDED_SOURCES_ARGUMENT];
  if (!folded_array_length(env, list, &sources->count)) { return NARSIL_INVALID_ARGUMENT; }
  size_t allocated = sources->count == 0 ? 1 : sources->count;
  if (allocated > SIZE_MAX / sizeof(expansion_storage)) { return NARSIL_OUT_OF_MEMORY; }
  sources->handles = calloc(allocated, sizeof *sources->handles);
  sources->storage = calloc(allocated, sizeof *sources->storage);
  sources->segments = calloc(allocated, sizeof *sources->segments);
  sources->tables = (const narsil_fold_table **)calloc(allocated, sizeof *sources->tables);
  if (sources->handles == NULL || sources->storage == NULL || sources->segments == NULL || sources->tables == NULL) {
    return NARSIL_OUT_OF_MEMORY;
  }
  for (uint32_t at = 0; at < sources->count; at++) {
    napi_value value;
    if (napi_get_element(env, list, at, &value) != napi_ok ||
        !prepare_expansion_source(env, value, sources->handles + at)) {
      return NARSIL_INVALID_ARGUMENT;
    }
  }
  for (uint32_t at = 0; at < sources->count; at++) {
    if (!read_expansion_source(env, sources->handles + at, sources->storage + at, sources->segments + at)) {
      return NARSIL_INVALID_ARGUMENT;
    }
  }
  return hold_fold_tables(env, thread, argv[FOLDED_TABLES_ARGUMENT], sources->count, sources->segments, language,
                          sources->tables);
}

static int read_units(napi_env env, napi_value value, const uint16_t **units, size_t *length) {
  void *data = NULL;
  if (!possibly_empty_typed_data(env, value, napi_uint16_array, &data, length)) { return 0; }
  *units = data;
  return 1;
}

static narsil_status read_excluded(napi_env env, napi_value value, narsil_term **terms, size_t *count) {
  uint32_t length = 0;
  if (!folded_array_length(env, value, &length)) { return NARSIL_INVALID_ARGUMENT; }
  *count = length;
  *terms = calloc(length == 0 ? 1 : length, sizeof **terms);
  if (*terms == NULL) { return NARSIL_OUT_OF_MEMORY; }
  for (uint32_t at = 0; at < length; at++) {
    napi_value element;
    size_t units = 0;
    if (napi_get_element(env, value, at, &element) != napi_ok ||
        !read_units(env, element, &(*terms)[at].units, &units) || units > UINT32_MAX) {
      return NARSIL_INVALID_ARGUMENT;
    }
    (*terms)[at].length = (uint32_t)units;
  }
  return NARSIL_OK;
}

static narsil_status read_word(napi_env env, napi_value value, narsil_folded_word *word, narsil_term **excluded) {
  napi_value key;
  napi_value own;
  napi_value terms;
  napi_value tolerance;
  napi_value prefix;
  if (napi_get_named_property(env, value, "key", &key) != napi_ok ||
      napi_get_named_property(env, value, "own", &own) != napi_ok ||
      napi_get_named_property(env, value, "excluded", &terms) != napi_ok ||
      napi_get_named_property(env, value, "tolerance", &tolerance) != napi_ok ||
      napi_get_named_property(env, value, "prefixLength", &prefix) != napi_ok ||
      !read_units(env, key, &word->key, &word->key_length) || !read_units(env, own, &word->own, &word->own_length) ||
      !segment_uint_argument(env, tolerance, &word->tolerance) ||
      !segment_uint_argument(env, prefix, &word->prefix_length)) {
    return NARSIL_INVALID_ARGUMENT;
  }
  narsil_status status = read_excluded(env, terms, excluded, &word->excluded_count);
  word->excluded = *excluded;
  return status;
}

static narsil_status run_terms(napi_env env, thread_state *thread, const napi_value *argv, uint32_t *count) {
  uint32_t language = 0;
  uint32_t word_count = 0;
  if (napi_get_value_uint32(env, argv[FOLDED_LANGUAGE_ARGUMENT], &language) != napi_ok ||
      !folded_array_length(env, argv[TERMS_WORDS], &word_count)) {
    return NARSIL_INVALID_ARGUMENT;
  }
  folded_sources sources = {NULL, NULL, NULL, NULL, 0};
  narsil_folded_word *words = calloc(word_count == 0 ? 1 : word_count, sizeof *words);
  narsil_term **excluded = (narsil_term **)calloc(word_count == 0 ? 1 : word_count, sizeof *excluded);
  narsil_status status = words == NULL || excluded == NULL ? NARSIL_OUT_OF_MEMORY : NARSIL_OK;
  for (uint32_t at = 0; status == NARSIL_OK && at < word_count; at++) {
    napi_value value;
    status = napi_get_element(env, argv[TERMS_WORDS], at, &value) == napi_ok
                 ? read_word(env, value, words + at, excluded + at)
                 : NARSIL_INVALID_ARGUMENT;
  }
  if (status == NARSIL_OK) { status = read_sources(env, thread, argv, language, &sources); }
  void *out[TERMS_OUTPUTS] = {NULL, NULL, NULL};
  size_t lengths[TERMS_OUTPUTS] = {0, 0, 0};
  for (size_t at = 0; status == NARSIL_OK && at < TERMS_OUTPUTS; at++) {
    if (!possibly_empty_typed_data(env, argv[TERMS_SEGMENTS + at], napi_uint32_array, out + at, lengths + at)) {
      status = NARSIL_INVALID_ARGUMENT;
    }
  }
  if (status == NARSIL_OK) {
    narsil_folded_request request = {sources.segments, sources.tables, sources.count, words, word_count};
    narsil_folded_output output = {out[0], lengths[0], out[1], lengths[1], out[2], lengths[2]};
    status = narsil_expand_folded_terms(thread->workspace, &request, &output, count);
  }
  for (uint32_t at = 0; excluded != NULL && at < word_count; at++) { free(excluded[at]); }
  free((void *)excluded);
  free(words);
  release_sources(&sources);
  return status;
}

static napi_value expand_folded_terms(napi_env env, napi_callback_info info) {
  napi_value argv[TERMS_COUNT];
  thread_state *thread = thread_state_of(env);
  if (thread == NULL || !callback_arguments(env, info, TERMS_COUNT, argv)) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  uint32_t count = 0;
  narsil_status status = run_terms(env, thread, argv, &count);
  report_workspace_memory(env, thread);
  return number_of(env, status == NARSIL_OK ? (int32_t)count : -(int32_t)status);
}

static narsil_status run_prefix(napi_env env, thread_state *thread, const napi_value *argv, uint32_t *count) {
  uint32_t language = 0;
  if (napi_get_value_uint32(env, argv[FOLDED_LANGUAGE_ARGUMENT], &language) != napi_ok) {
    return NARSIL_INVALID_ARGUMENT;
  }
  const uint16_t *texts[PREFIX_TEXTS] = {NULL, NULL, NULL, NULL};
  size_t text_lengths[PREFIX_TEXTS] = {0, 0, 0, 0};
  for (size_t at = 0; at < PREFIX_TEXTS; at++) {
    if (!read_units(env, argv[PREFIX_TYPED + at], texts + at, text_lengths + at)) { return NARSIL_INVALID_ARGUMENT; }
  }
  void *out[PREFIX_OUTPUTS] = {NULL, NULL, NULL};
  size_t lengths[PREFIX_OUTPUTS] = {0, 0, 0};
  for (size_t at = 0; at < PREFIX_OUTPUTS; at++) {
    napi_typedarray_type type = PREFIX_SEGMENTS + at == PREFIX_FACTORS ? napi_float64_array : napi_uint32_array;
    if (!possibly_empty_typed_data(env, argv[PREFIX_SEGMENTS + at], type, out + at, lengths + at)) {
      return NARSIL_INVALID_ARGUMENT;
    }
  }
  folded_sources sources = {NULL, NULL, NULL, NULL, 0};
  narsil_status status = read_sources(env, thread, argv, language, &sources);
  if (status == NARSIL_OK) {
    narsil_folded_prefix_request request = {{sources.segments, sources.count, texts[0], text_lengths[0], texts[1],
                                             text_lengths[1], texts[2], text_lengths[2]},
                                            sources.tables,
                                            texts[3],
                                            text_lengths[3]};
    narsil_expansion_output output = {out[0], lengths[0], out[1], lengths[1], out[2], lengths[2]};
    status = narsil_expand_folded_prefix(thread->workspace, &request, &output, count);
  }
  release_sources(&sources);
  return status;
}

static napi_value expand_folded_prefix(napi_env env, napi_callback_info info) {
  napi_value argv[PREFIX_COUNT];
  thread_state *thread = thread_state_of(env);
  if (thread == NULL || !callback_arguments(env, info, PREFIX_COUNT, argv)) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  uint32_t count = 0;
  narsil_status status = run_prefix(env, thread, argv, &count);
  report_workspace_memory(env, thread);
  return number_of(env, status == NARSIL_OK ? (int32_t)count : -(int32_t)status);
}

int define_folding(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"createFoldTable", NULL, create_fold_table, NULL, NULL, NULL, napi_default_method, NULL},
      {"expandFoldedTerms", NULL, expand_folded_terms, NULL, NULL, NULL, napi_default_method, NULL},
      {"expandFoldedPrefix", NULL, expand_folded_prefix, NULL, NULL, NULL, napi_default_method, NULL},
      {"expandFoldedPartialWords", NULL, expand_folded_partial_words, NULL, NULL, NULL, napi_default_method, NULL}};
  return napi_define_properties(env, exports, sizeof properties / sizeof properties[0], properties) == napi_ok;
}
