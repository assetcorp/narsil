#ifndef NARSIL_NODE_PHRASE_VALUES_H
#define NARSIL_NODE_PHRASE_VALUES_H

#include "../include/narsil_phrases.h"

#include <js_native_api.h>
#include <stddef.h>
#include <stdint.h>

enum {
  PHRASE_POSTINGS,
  PHRASE_STARTS,
  PHRASE_TOKENS,
  PHRASE_OFFSETS,
  PHRASE_SEARCHABLE,
  PHRASE_FILTER,
  PHRASE_REMOVED,
  PHRASE_ORDINALS,
  PHRASE_COLLECT,
  PHRASE_PROPERTIES
};
enum {
  PHRASE_DOCUMENTS,
  PHRASE_FIELDS,
  PHRASE_POSITION_STARTS,
  PHRASE_POSITION_COUNTS,
  PHRASE_POSITIONS,
  PHRASE_ORDERED,
  PHRASE_LIST_PROPERTIES
};

typedef struct {
  napi_value values[PHRASE_LIST_PROPERTIES];
  int ordered;
} phrase_list_handles;

typedef struct {
  napi_value values[PHRASE_PROPERTIES];
  phrase_list_handles *lists;
  narsil_phrase_postings *postings;
  uint32_t count;
  uint32_t ordinal_count;
  int collect;
  int has_filter;
} phrase_handles;

narsil_status prepare_phrase_handles(napi_env env, napi_value input, phrase_handles *handles);
int read_phrase_handles(napi_env env, const phrase_handles *handles, narsil_phrase_request *request);
void release_phrase_handles(phrase_handles *handles);

#endif
