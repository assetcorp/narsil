#ifndef NARSIL_NODE_FROZEN_SEGMENTS_H
#define NARSIL_NODE_FROZEN_SEGMENTS_H

#include "../include/narsil_frozen_segments.h"

#include <js_native_api_types.h>
#include <stdint.h>

enum { FROZEN_STRING_HANDLES = 3, FROZEN_POSTING_HANDLES = 7, FROZEN_STATE_HANDLES = 6, FROZEN_INDEX_HANDLES = 3 };

typedef struct {
  napi_value terms[FROZEN_STRING_HANDLES];
  napi_value surfaces[FROZEN_STRING_HANDLES];
  napi_value spellings[FROZEN_STRING_HANDLES];
  napi_value postings[FROZEN_POSTING_HANDLES];
  napi_value state[FROZEN_STATE_HANDLES];
  napi_value index[FROZEN_INDEX_HANDLES];
  napi_value removal_terms;
  uint32_t document_count;
  int has_surfaces;
  int has_spellings;
  int has_index;
  int has_removal_terms;
} frozen_handles;

typedef struct {
  narsil_frozen_segment segment;
  narsil_frozen_segment_state state;
  narsil_frozen_strings surfaces;
  narsil_frozen_strings spellings;
  narsil_frozen_removal_index index;
} node_frozen_segment;

int prepare_frozen_segment(napi_env env, napi_value source, napi_value state, frozen_handles *handles);
int read_frozen_segment(napi_env env, const frozen_handles *handles, node_frozen_segment *segment);

#endif
