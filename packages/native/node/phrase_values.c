#include "phrase_values.h"

#include "../include/narsil_core.h"
#include "../include/narsil_phrases.h"
#include "values.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <math.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

void release_phrase_handles(phrase_handles *handles) {
  free(handles->lists);
  free(handles->postings);
}

static int prepare_lists(napi_env env, phrase_handles *handles) {
  static const char *const properties[PHRASE_LIST_PROPERTIES] = {"documents",      "fields",    "positionStarts",
                                                                 "positionCounts", "positions", "ordered"};
  for (uint32_t at = 0; at < handles->count; at++) {
    napi_value list;
    if (napi_get_element(env, handles->values[PHRASE_POSTINGS], at, &list) != napi_ok) { return 0; }
    for (size_t property = 0; property < PHRASE_LIST_PROPERTIES; property++) {
      if (napi_get_named_property(env, list, properties[property], &handles->lists[at].values[property]) != napi_ok) {
        return 0;
      }
    }
    bool ordered = false;
    if (napi_get_value_bool(env, handles->lists[at].values[PHRASE_ORDERED], &ordered) != napi_ok) { return 0; }
    handles->lists[at].ordered = (int)ordered;
  }
  return 1;
}

narsil_status prepare_phrase_handles(napi_env env, napi_value input, phrase_handles *handles) {
  static const char *const properties[PHRASE_PROPERTIES] = {
      "postings", "starts", "tokens", "offsets", "searchable", "filter", "removed", "ordinalCount", "collect"};
  for (size_t at = 0; at < PHRASE_PROPERTIES; at++) {
    if (napi_get_named_property(env, input, properties[at], &handles->values[at]) != napi_ok) {
      return NARSIL_INVALID_ARGUMENT;
    }
  }
  bool array = false;
  bool collect = false;
  double ordinals = 0;
  napi_valuetype filter = napi_undefined;
  if (napi_is_array(env, handles->values[PHRASE_POSTINGS], &array) != napi_ok || !array ||
      napi_get_array_length(env, handles->values[PHRASE_POSTINGS], &handles->count) != napi_ok ||
      napi_get_value_bool(env, handles->values[PHRASE_COLLECT], &collect) != napi_ok ||
      napi_get_value_double(env, handles->values[PHRASE_ORDINALS], &ordinals) != napi_ok || !isfinite(ordinals) ||
      ordinals < 0 || ordinals > UINT32_MAX || floor(ordinals) != ordinals ||
      napi_typeof(env, handles->values[PHRASE_FILTER], &filter) != napi_ok) {
    return NARSIL_INVALID_ARGUMENT;
  }
  handles->ordinal_count = (uint32_t)ordinals;
  handles->collect = (int)collect;
  handles->has_filter = filter != napi_null;
  size_t count = handles->count;
  if (count > SIZE_MAX / sizeof *handles->lists || count > SIZE_MAX / sizeof *handles->postings) {
    return NARSIL_OUT_OF_MEMORY;
  }
  if (count > 0) {
    handles->lists = calloc(count, sizeof *handles->lists);
    handles->postings = calloc(count, sizeof *handles->postings);
    if (handles->lists == NULL || handles->postings == NULL) { return NARSIL_OUT_OF_MEMORY; }
  }
  return prepare_lists(env, handles) ? NARSIL_OK : NARSIL_INVALID_ARGUMENT;
}

static int read_lists(napi_env env, const phrase_handles *handles) {
  for (uint32_t at = 0; at < handles->count; at++) {
    void *regions[PHRASE_ORDERED];
    size_t lengths[PHRASE_ORDERED];
    for (size_t property = 0; property < PHRASE_ORDERED; property++) {
      napi_typedarray_type type = property == PHRASE_FIELDS ? napi_uint16_array : napi_uint32_array;
      if (!possibly_empty_typed_data(env, handles->lists[at].values[property], type, &regions[property],
                                     &lengths[property])) {
        return 0;
      }
    }
    if (lengths[PHRASE_FIELDS] != lengths[PHRASE_DOCUMENTS] ||
        lengths[PHRASE_POSITION_STARTS] != lengths[PHRASE_DOCUMENTS] ||
        lengths[PHRASE_POSITION_COUNTS] != lengths[PHRASE_DOCUMENTS]) {
      return 0;
    }
    handles->postings[at] = (narsil_phrase_postings){regions[PHRASE_DOCUMENTS],       regions[PHRASE_FIELDS],
                                                     regions[PHRASE_POSITION_STARTS], regions[PHRASE_POSITION_COUNTS],
                                                     lengths[PHRASE_DOCUMENTS],       regions[PHRASE_POSITIONS],
                                                     lengths[PHRASE_POSITIONS],       handles->lists[at].ordered};
  }
  return 1;
}

int read_phrase_handles(napi_env env, const phrase_handles *handles, narsil_phrase_request *request) {
  void *regions[PHRASE_ORDINALS] = {0};
  size_t lengths[PHRASE_ORDINALS] = {0};
  if (!read_lists(env, handles)) { return 0; }
  for (size_t at = PHRASE_STARTS; at < PHRASE_ORDINALS; at++) {
    if (at == PHRASE_FILTER && !handles->has_filter) { continue; }
    napi_typedarray_type type = at == PHRASE_SEARCHABLE ? napi_uint8_array : napi_uint32_array;
    if (!possibly_empty_typed_data(env, handles->values[at], type, &regions[at], &lengths[at])) { return 0; }
  }
  if (lengths[PHRASE_STARTS] == 0 || (handles->has_filter && lengths[PHRASE_FILTER] == 0) ||
      lengths[PHRASE_TOKENS] != lengths[PHRASE_OFFSETS] || lengths[PHRASE_SEARCHABLE] > UINT32_MAX) {
    return 0;
  }
  *request = (narsil_phrase_request){handles->postings,
                                     handles->count,
                                     regions[PHRASE_STARTS],
                                     lengths[PHRASE_STARTS] - 1,
                                     regions[PHRASE_TOKENS],
                                     regions[PHRASE_OFFSETS],
                                     lengths[PHRASE_TOKENS],
                                     regions[PHRASE_SEARCHABLE],
                                     (uint32_t)lengths[PHRASE_SEARCHABLE],
                                     regions[PHRASE_FILTER],
                                     lengths[PHRASE_FILTER],
                                     regions[PHRASE_REMOVED],
                                     lengths[PHRASE_REMOVED],
                                     handles->ordinal_count,
                                     handles->collect,
                                     {0}};
  return 1;
}
