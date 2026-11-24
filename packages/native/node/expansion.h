#ifndef NARSIL_NODE_EXPANSION_H
#define NARSIL_NODE_EXPANSION_H

#include "../include/narsil_expansion.h"
#include "frozen_segments.h"
#include "segments.h"

#include <js_native_api_types.h>

typedef struct {
  segment_handles growing;
  frozen_handles frozen;
  napi_value occurrences;
  int has_occurrences;
  int has_growing;
} expansion_handles;

typedef struct {
  node_segment growing;
  node_frozen_segment frozen;
} expansion_storage;

enum { PARTIAL_RUN_POINTS, PARTIAL_RUN_OFFSETS, PARTIAL_RUN_MEMBERS, PARTIAL_RUN_REGIONS };

typedef struct {
  expansion_handles source;
  napi_value runs[PARTIAL_RUN_REGIONS];
  int has_runs;
} partial_handles;

typedef struct {
  napi_value written;
  napi_value own;
  uint32_t tolerance;
  uint32_t prefix_length;
} partial_word_handles;

int prepare_expansion_source(napi_env env, napi_value value, expansion_handles *handles);
int read_expansion_source(napi_env env, const expansion_handles *handles, expansion_storage *storage,
                          narsil_expansion_segment *source);
int prepare_partial_source(napi_env env, napi_value value, partial_handles *handles);
int read_partial_runs(napi_env env, const partial_handles *handles, narsil_frozen_runs *runs);
int prepare_partial_word(napi_env env, napi_value value, partial_word_handles *handles);
int read_partial_word(napi_env env, const partial_word_handles *handles, narsil_partial_word *word);
int define_folding(napi_env env, napi_value exports);
napi_value expand_partial_words(napi_env env, napi_callback_info info);
napi_value suggest_terms(napi_env env, napi_callback_info info);
int define_expansion(napi_env env, napi_value exports);

#endif
