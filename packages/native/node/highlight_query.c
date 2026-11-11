#include "highlight.h"

#include "../include/narsil_analysis.h"
#include "../include/narsil_highlight.h"
#include "segments.h"
#include "values.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

static int list_length(napi_env env, napi_value list, size_t *length) {
  bool array = false;
  uint32_t count = 0;
  if (napi_is_array(env, list, &array) != napi_ok || !array || napi_get_array_length(env, list, &count) != napi_ok) {
    return 0;
  }
  *length = count;
  return 1;
}

static int allocate_list(size_t count, napi_value **handles, narsil_highlight_text **values) {
  size_t capacity = count == 0 ? 1 : count;
  if (capacity > SIZE_MAX / sizeof **handles || capacity > SIZE_MAX / sizeof **values) { return 0; }
  *handles = (napi_value *)calloc(capacity, sizeof **handles);
  *values = calloc(capacity, sizeof **values);
  return *handles != NULL && *values != NULL;
}

static int prepare_texts(napi_env env, napi_value list, napi_value **handles, narsil_highlight_text **values,
                         size_t *count) {
  if (!list_length(env, list, count) || !allocate_list(*count, handles, values)) { return 0; }
  for (size_t at = 0; at < *count; at++) {
    if (napi_get_element(env, list, (uint32_t)at, *handles + at) != napi_ok) { return 0; }
  }
  return 1;
}

static int prepare_terms(napi_env env, napi_value list, highlight_handles *handles) {
  if (!list_length(env, list, &handles->query.term_count)) { return 0; }
  size_t capacity = handles->query.term_count == 0 ? 1 : handles->query.term_count;
  if (capacity > SIZE_MAX / sizeof *handles->terms || capacity > SIZE_MAX / sizeof *handles->term_values) { return 0; }
  handles->terms = (napi_value *)calloc(capacity, sizeof *handles->terms);
  handles->term_values = calloc(capacity, sizeof *handles->term_values);
  if (handles->terms == NULL || handles->term_values == NULL) { return 0; }
  for (size_t at = 0; at < handles->query.term_count; at++) {
    napi_value term;
    napi_value tolerance;
    if (napi_get_element(env, list, (uint32_t)at, &term) != napi_ok ||
        napi_get_named_property(env, term, "term", handles->terms + at) != napi_ok ||
        napi_get_named_property(env, term, "tolerance", &tolerance) != napi_ok ||
        !segment_uint_argument(env, tolerance, &handles->term_values[at].tolerance)) {
      return 0;
    }
  }
  return 1;
}

int prepare_highlight_query(napi_env env, napi_value value, highlight_handles *handles) {
  napi_value terms;
  napi_value prefix_length;
  napi_value synonyms;
  napi_value partial;
  napi_valuetype type;
  if (napi_get_named_property(env, value, "terms", &terms) != napi_ok ||
      napi_get_named_property(env, value, "prefixLength", &prefix_length) != napi_ok ||
      napi_get_named_property(env, value, "prefix", &handles->prefix) != napi_ok ||
      napi_get_named_property(env, value, "synonyms", &synonyms) != napi_ok ||
      napi_get_named_property(env, value, "partialWords", &partial) != napi_ok ||
      !segment_uint_argument(env, prefix_length, &handles->query.prefix_length) ||
      !prepare_terms(env, terms, handles) ||
      !prepare_texts(env, synonyms, &handles->synonyms, &handles->synonym_values, &handles->query.synonym_count) ||
      napi_typeof(env, partial, &type) != napi_ok) {
    return 0;
  }
  return type == napi_null ||
         prepare_texts(env, partial, &handles->partial, &handles->partial_values, &handles->query.partial_count);
}

int read_highlight_text(napi_env env, napi_value value, narsil_highlight_text *text) {
  void *data = NULL;
  size_t length = 0;
  if (!possibly_empty_typed_data(env, value, napi_uint16_array, &data, &length) || length > NARSIL_MAX_ANALYSED_UNITS) {
    return 0;
  }
  static const uint16_t empty = 0;
  *text = (narsil_highlight_text){length == 0 ? &empty : data, length};
  return 1;
}

int read_highlight_query(napi_env env, highlight_handles *handles) {
  napi_valuetype type;
  if (napi_typeof(env, handles->prefix, &type) != napi_ok ||
      (type != napi_null && !read_highlight_text(env, handles->prefix, &handles->query.prefix))) {
    return 0;
  }
  for (size_t at = 0; at < handles->query.term_count; at++) {
    if (!read_highlight_text(env, handles->terms[at], &handles->term_values[at].text)) { return 0; }
  }
  for (size_t at = 0; at < handles->query.synonym_count; at++) {
    if (!read_highlight_text(env, handles->synonyms[at], handles->synonym_values + at)) { return 0; }
  }
  for (size_t at = 0; at < handles->query.partial_count; at++) {
    if (!read_highlight_text(env, handles->partial[at], handles->partial_values + at)) { return 0; }
  }
  handles->query.terms = handles->term_values;
  handles->query.synonyms = handles->synonym_values;
  handles->query.partial_words = handles->partial_values;
  return 1;
}

void release_highlight_query(highlight_handles *handles) {
  free((void *)handles->terms);
  free((void *)handles->synonyms);
  free((void *)handles->partial);
  free(handles->term_values);
  free(handles->synonym_values);
  free(handles->partial_values);
}
