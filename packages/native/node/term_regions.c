#include "terms.h"

#include "../include/narsil_terms.h"
#include "values.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <stddef.h>

static const char *const TABLE_PROPERTIES[TERM_HANDLES] = {
    "header", "slots", "termOffset", "termLength", "firstUnitNext", "firstUnitHead", "units",
};
static const char *const DICTIONARY_PROPERTIES[DICTIONARY_HANDLES] = {
    "tokens",
    "offsets",
    "frequencies",
    "removed",
};

int prepare_term_table(napi_env env, napi_value value, napi_value handles[TERM_HANDLES]) {
  for (size_t at = 0; at < TERM_HANDLES; at++) {
    if (napi_get_named_property(env, value, TABLE_PROPERTIES[at], &handles[at]) != napi_ok) { return 0; }
  }
  return 1;
}

int prepare_term_dictionary(napi_env env, napi_value value, term_handles *handles) {
  napi_value growing = NULL;
  napi_valuetype type = napi_undefined;
  if (napi_get_named_property(env, value, "growing", &growing) != napi_ok ||
      napi_typeof(env, growing, &type) != napi_ok) {
    return 0;
  }
  handles->growing = type != napi_null;
  if (handles->growing) {
    if (type != napi_object) { return 0; }
    if (!prepare_term_table(env, growing, handles->table)) { return 0; }
  }
  for (size_t at = 0; at < DICTIONARY_HANDLES; at++) {
    if (napi_get_named_property(env, value, DICTIONARY_PROPERTIES[at], &handles->dictionary[at]) != napi_ok) {
      return 0;
    }
  }
  return 1;
}

int read_term_table(napi_env env, const napi_value handles[TERM_HANDLES], narsil_term_table *table) {
  enum { HEADER, SLOTS, OFFSET, LENGTH, NEXT, HEAD, UNITS };
  const napi_typedarray_type types[TERM_HANDLES] = {
      napi_uint32_array, napi_int32_array,  napi_uint32_array, napi_uint32_array,
      napi_uint32_array, napi_uint32_array, napi_uint16_array,
  };
  void *data[TERM_HANDLES] = {0};
  size_t counts[TERM_HANDLES] = {0};
  for (size_t at = 0; at < TERM_HANDLES; at++) {
    if (!possibly_empty_typed_data(env, handles[at], types[at], &data[at], &counts[at])) { return 0; }
  }
  *table = (narsil_term_table){data[HEADER],   counts[HEADER], data[SLOTS],    counts[SLOTS], data[OFFSET],
                               counts[OFFSET], data[LENGTH],   counts[LENGTH], data[NEXT],    counts[NEXT],
                               data[HEAD],     counts[HEAD],   data[UNITS],    counts[UNITS]};
  return 1;
}

int read_term_dictionary(napi_env env, const term_handles *handles, narsil_term_table *table,
                         narsil_term_dictionary *dictionary) {
  enum { TOKENS, OFFSETS, FREQUENCIES, REMOVED };
  if (handles->growing && !read_term_table(env, handles->table, table)) { return 0; }
  void *data[DICTIONARY_HANDLES] = {0};
  size_t counts[DICTIONARY_HANDLES] = {0};
  for (size_t at = 0; at < DICTIONARY_HANDLES; at++) {
    napi_typedarray_type type = at == TOKENS ? napi_uint8_array : napi_uint32_array;
    if (!possibly_empty_typed_data(env, handles->dictionary[at], type, &data[at], &counts[at])) { return 0; }
  }
  *dictionary = (narsil_term_dictionary){handles->growing ? table : NULL,
                                         data[TOKENS],
                                         counts[TOKENS],
                                         data[OFFSETS],
                                         counts[OFFSETS],
                                         data[FREQUENCIES],
                                         counts[FREQUENCIES],
                                         data[REMOVED],
                                         counts[REMOVED]};
  return 1;
}
