#ifndef NARSIL_NODE_SEGMENT_MERGE_H
#define NARSIL_NODE_SEGMENT_MERGE_H

#include "../include/narsil_frozen_segments.h"
#include "../include/narsil_posting_merge.h"
#include "../include/narsil_segment_merge.h"
#include "segments.h"

#include <js_native_api_types.h>
#include <stddef.h>
#include <stdint.h>

enum { MERGE_STRING_HANDLES = 3, MERGE_INPUT_HANDLES = 9, MERGE_OUTPUT_HANDLES = 8, MERGE_SIZE_WORDS = 9 };

typedef struct {
  napi_value terms[MERGE_STRING_HANDLES];
  napi_value surfaces[MERGE_STRING_HANDLES];
  napi_value spellings[MERGE_STRING_HANDLES];
  napi_value arrays[MERGE_INPUT_HANDLES];
  napi_value *lengths;
  uint32_t document_count;
  uint32_t field_count;
  int has_surfaces;
  int has_spellings;
  int out_of_memory;
  int has_growing;
  segment_handles growing;
} merge_input_handles;

typedef struct {
  napi_value terms[MERGE_STRING_HANDLES];
  napi_value surfaces[MERGE_STRING_HANDLES];
  napi_value spellings[MERGE_STRING_HANDLES];
  napi_value arrays[MERGE_OUTPUT_HANDLES];
} merge_output_handles;

typedef struct {
  narsil_frozen_strings surfaces;
  narsil_frozen_strings spellings;
  const uint32_t **lengths;
  int out_of_memory;
  node_segment growing;
} merge_input_storage;

int prepare_merge_input(napi_env env, napi_value value, merge_input_handles *handles);
int prepare_merge_strings(napi_env env, napi_value value, napi_value *handles);
int read_merge_strings(napi_env env, const napi_value *handles, size_t stride, narsil_frozen_strings *table);
int prepare_merge_output(napi_env env, napi_value value, merge_output_handles *handles);
int read_merge_input(napi_env env, const merge_input_handles *handles, narsil_keyword_merge_input *input,
                     merge_input_storage *storage);
int read_merge_output(napi_env env, const merge_output_handles *handles, narsil_keyword_merge_output *output);
int merge_read_arrays(napi_env env, const napi_value *handles, const napi_typedarray_type *types, size_t count,
                      void **data, size_t *lengths, uint32_t nullable);
int define_segment_merges(napi_env env, napi_value exports);
int define_field_merges(napi_env env, napi_value exports);
int prepare_posting_output(napi_env env, napi_value value, napi_value *handles);
int read_posting_output(napi_env env, const napi_value *handles, narsil_posting_merge_output *output);

#endif
