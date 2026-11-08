#ifndef NARSIL_NODE_SEGMENTS_H
#define NARSIL_NODE_SEGMENTS_H

#include "../include/narsil_segments.h"
#include "terms.h"

#include <js_native_api_types.h>
#include <stddef.h>
#include <stdint.h>

enum { SEGMENT_COLUMN_HANDLES = 9, SEGMENT_POSTING_HANDLES = 7, SEGMENT_RUN_HANDLES = 10, SEGMENT_VALUE_HANDLES = 5 };

typedef struct {
  napi_value tokens;
  napi_value units;
  uint32_t field;
} field_handles;

typedef struct {
  napi_value strings[TERM_HANDLES];
  napi_value token;
  napi_value count;
} surface_handles;

typedef struct {
  napi_value terms[TERM_HANDLES];
  napi_value columns[SEGMENT_COLUMN_HANDLES];
  napi_value postings[SEGMENT_POSTING_HANDLES];
  napi_value values[SEGMENT_VALUE_HANDLES];
  napi_value positions;
  napi_value position_allocation;
  surface_handles surfaces;
  surface_handles spellings;
  napi_value code_points;
  napi_value runs[SEGMENT_RUN_HANDLES];
  uint32_t ordinal_capacity;
  int has_positions;
  int has_surfaces;
  int has_spellings;
} segment_handles;

typedef struct {
  narsil_growing_segment growing;
  narsil_surface_table surfaces;
  narsil_spelling_table spellings;
  narsil_position_pool positions;
} node_segment;

int segment_uint_argument(napi_env env, napi_value value, uint32_t *number);
int prepare_segment(napi_env env, napi_value value, segment_handles *handles);
int read_segment(napi_env env, const segment_handles *handles, node_segment *segment);
int read_segment_arrays(napi_env env, const napi_value *handles, const napi_typedarray_type *types, size_t count,
                        void **data, size_t *lengths);
int read_segment_optional(napi_env env, const segment_handles *handles, node_segment *segment);
int define_segments(napi_env env, napi_value exports);
int prepare_segment_fields(napi_env env, napi_value list, field_handles *fields, uint32_t count);
int read_segment_fields(napi_env env, const field_handles *handles, narsil_field_tokens *fields, uint32_t count);
napi_value remove_frozen_document(napi_env env, napi_callback_info info);
napi_value prepare_frozen_removal(napi_env env, napi_callback_info info);

#endif
