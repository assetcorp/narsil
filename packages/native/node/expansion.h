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

int prepare_expansion_source(napi_env env, napi_value value, expansion_handles *handles);
int read_expansion_source(napi_env env, const expansion_handles *handles, expansion_storage *storage,
                          narsil_expansion_segment *source);
napi_value expand_partial_words(napi_env env, napi_callback_info info);
napi_value suggest_terms(napi_env env, napi_callback_info info);
int define_expansion(napi_env env, napi_value exports);

#endif
