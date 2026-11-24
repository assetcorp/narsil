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

static int prepare_optional_texts(napi_env env, napi_value list, napi_value **handles, narsil_highlight_text **values,
                                  size_t *count) {
  napi_valuetype type;
  if (napi_typeof(env, list, &type) != napi_ok) { return 0; }
  return type == napi_null || prepare_texts(env, list, handles, values, count);
}

static int prepare_terms(napi_env env, napi_value list, const char *text_name, napi_value **handles,
                         narsil_highlight_term **values, size_t *count) {
  if (!list_length(env, list, count)) { return 0; }
  size_t capacity = *count == 0 ? 1 : *count;
  if (capacity > SIZE_MAX / sizeof **handles || capacity > SIZE_MAX / sizeof **values) { return 0; }
  *handles = (napi_value *)calloc(capacity, sizeof **handles);
  *values = calloc(capacity, sizeof **values);
  if (*handles == NULL || *values == NULL) { return 0; }
  for (size_t at = 0; at < *count; at++) {
    napi_value term;
    napi_value tolerance;
    if (napi_get_element(env, list, (uint32_t)at, &term) != napi_ok ||
        napi_get_named_property(env, term, text_name, *handles + at) != napi_ok ||
        napi_get_named_property(env, term, "tolerance", &tolerance) != napi_ok ||
        !segment_uint_argument(env, tolerance, &(*values)[at].tolerance)) {
      return 0;
    }
  }
  return 1;
}

static int prepare_folded(napi_env env, napi_value value, highlight_handles *handles) {
  napi_value folded;
  napi_valuetype type;
  if (napi_get_named_property(env, value, "folded", &folded) != napi_ok || napi_typeof(env, folded, &type) != napi_ok) {
    return 0;
  }
  if (type == napi_null) { return 1; }
  folded_highlight_handles *held = &handles->folded;
  napi_value keys;
  napi_value partial;
  handles->folds = 1;
  return napi_get_named_property(env, folded, "keys", &keys) == napi_ok &&
         napi_get_named_property(env, folded, "prefix", &held->prefix) == napi_ok &&
         napi_get_named_property(env, folded, "partialWords", &partial) == napi_ok &&
         prepare_terms(env, keys, "key", &held->keys, &held->key_values, &held->query.key_count) &&
         prepare_optional_texts(env, partial, &held->partial, &held->partial_values, &held->query.partial_count);
}

int prepare_highlight_query(napi_env env, napi_value value, highlight_handles *handles) {
  napi_value terms;
  napi_value prefix_length;
  napi_value synonyms;
  napi_value partial;
  narsil_highlight_query *query = &handles->query;
  return napi_get_named_property(env, value, "terms", &terms) == napi_ok &&
         napi_get_named_property(env, value, "prefixLength", &prefix_length) == napi_ok &&
         napi_get_named_property(env, value, "prefix", &handles->prefix) == napi_ok &&
         napi_get_named_property(env, value, "synonyms", &synonyms) == napi_ok &&
         napi_get_named_property(env, value, "partialWords", &partial) == napi_ok &&
         segment_uint_argument(env, prefix_length, &query->prefix_length) &&
         prepare_terms(env, terms, "term", &handles->terms, &handles->term_values, &query->term_count) &&
         prepare_texts(env, synonyms, &handles->synonyms, &handles->synonym_values, &query->synonym_count) &&
         prepare_optional_texts(env, partial, &handles->partial, &handles->partial_values, &query->partial_count) &&
         prepare_folded(env, value, handles);
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

static int read_optional_text(napi_env env, napi_value value, narsil_highlight_text *text) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok) { return 0; }
  return type == napi_null || read_highlight_text(env, value, text);
}

static int read_terms(napi_env env, const napi_value *handles, narsil_highlight_term *values, size_t count) {
  for (size_t at = 0; at < count; at++) {
    if (!read_highlight_text(env, handles[at], &values[at].text)) { return 0; }
  }
  return 1;
}

static int read_texts(napi_env env, const napi_value *handles, narsil_highlight_text *values, size_t count) {
  for (size_t at = 0; at < count; at++) {
    if (!read_highlight_text(env, handles[at], values + at)) { return 0; }
  }
  return 1;
}

static int read_folded(napi_env env, folded_highlight_handles *held) {
  if (!read_optional_text(env, held->prefix, &held->query.prefix) ||
      !read_terms(env, held->keys, held->key_values, held->query.key_count) ||
      !read_texts(env, held->partial, held->partial_values, held->query.partial_count)) {
    return 0;
  }
  held->query.keys = held->key_values;
  held->query.partial_words = held->partial_values;
  return 1;
}

int read_highlight_query(napi_env env, highlight_handles *handles) {
  narsil_highlight_query *query = &handles->query;
  if (!read_optional_text(env, handles->prefix, &query->prefix) ||
      !read_terms(env, handles->terms, handles->term_values, query->term_count) ||
      !read_texts(env, handles->synonyms, handles->synonym_values, query->synonym_count) ||
      !read_texts(env, handles->partial, handles->partial_values, query->partial_count) ||
      (handles->folds && !read_folded(env, &handles->folded))) {
    return 0;
  }
  query->terms = handles->term_values;
  query->synonyms = handles->synonym_values;
  query->partial_words = handles->partial_values;
  query->folded = handles->folds ? &handles->folded.query : NULL;
  return 1;
}

void release_highlight_query(highlight_handles *handles) {
  free((void *)handles->terms);
  free((void *)handles->synonyms);
  free((void *)handles->partial);
  free(handles->term_values);
  free(handles->synonym_values);
  free(handles->partial_values);
  free((void *)handles->folded.keys);
  free((void *)handles->folded.partial);
  free(handles->folded.key_values);
  free(handles->folded.partial_values);
}
