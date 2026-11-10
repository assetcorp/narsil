#ifndef NARSIL_NODE_FROZEN_SEGMENTS_H
#define NARSIL_NODE_FROZEN_SEGMENTS_H

#include "../include/narsil_frozen_segments.h"
#include "../include/narsil_paged.h"
#include "paged.h"

#include <js_native_api_types.h>
#include <stdint.h>

enum { FROZEN_STRING_HANDLES = 3, FROZEN_POSTING_HANDLES = 7, FROZEN_STATE_HANDLES = 10, FROZEN_INDEX_HANDLES = 3 };

typedef struct {
  napi_value terms[FROZEN_STRING_HANDLES];
  napi_value surfaces[FROZEN_STRING_HANDLES];
  napi_value spellings[FROZEN_STRING_HANDLES];
  napi_value postings[FROZEN_POSTING_HANDLES];
  napi_value state[FROZEN_STATE_HANDLES];
  napi_value index[FROZEN_INDEX_HANDLES];
  uint32_t document_count;
  int has_surfaces;
  int has_spellings;
  int has_index;
} frozen_handles;

typedef struct {
  page_handles offsets;
  page_handles values;
  page_cache_handles cache;
  napi_value fault;
  int present;
} frozen_paged_handles;

typedef struct {
  narsil_page_section offsets;
  narsil_page_section values;
  narsil_page_cache cache;
  narsil_frozen_paged_removals removals;
} node_frozen_paged;

typedef struct {
  narsil_frozen_segment segment;
  narsil_frozen_segment_state state;
  narsil_frozen_strings surfaces;
  narsil_frozen_strings spellings;
  narsil_frozen_removal_index index;
} node_frozen_segment;

int prepare_frozen_segment(napi_env env, napi_value source, napi_value state, frozen_handles *handles);
int read_frozen_segment(napi_env env, const frozen_handles *handles, node_frozen_segment *segment);
int prepare_frozen_paged(napi_env env, napi_value value, frozen_paged_handles *handles);
int read_frozen_paged(napi_env env, const frozen_paged_handles *handles, node_frozen_paged *paged,
                      const narsil_frozen_paged_removals **removals);

#endif
