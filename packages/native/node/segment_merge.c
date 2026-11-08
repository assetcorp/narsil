#include "segment_merge.h"

#include "../include/narsil_core.h"
#include "../include/narsil_frozen_segments.h"
#include "../include/narsil_posting_merge.h"
#include "../include/narsil_segment_merge.h"
#include "segments.h"
#include "values.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

enum { INPUTS, DOCUMENTS, FIELDS, OUTPUT, RETAINED_TERMS, MERGE_ARGUMENTS };
enum { POSTING_OUTPUTS = 6 };

typedef struct {
  narsil_keyword_merge_input *inputs;
  merge_input_handles *handles;
  merge_input_storage *storage;
  uint32_t count;
  uint32_t prepared;
} node_merge;

static void release(node_merge *merge) {
  for (size_t at = 0; at < merge->prepared; at++) {
    if (merge->handles != NULL) { free((void *)merge->handles[at].lengths); }
    if (merge->storage != NULL) { free((void *)merge->storage[at].lengths); }
  }
  free(merge->inputs);
  free(merge->handles);
  free(merge->storage);
}

static narsil_status prepare(napi_env env, napi_value list, node_merge *merge) {
  bool array = false;
  if (napi_is_array(env, list, &array) != napi_ok || !array ||
      napi_get_array_length(env, list, &merge->count) != napi_ok) {
    return NARSIL_INVALID_ARGUMENT;
  }
  if (merge->count == 0) { return NARSIL_OK; }
  size_t count = merge->count;
  if (count > SIZE_MAX / sizeof *merge->inputs || count > SIZE_MAX / sizeof *merge->handles ||
      count > SIZE_MAX / sizeof *merge->storage) {
    return NARSIL_OUT_OF_MEMORY;
  }
  merge->inputs = calloc(merge->count, sizeof *merge->inputs);
  merge->handles = calloc(merge->count, sizeof *merge->handles);
  merge->storage = calloc(merge->count, sizeof *merge->storage);
  if (merge->inputs == NULL || merge->handles == NULL || merge->storage == NULL) { return NARSIL_OUT_OF_MEMORY; }
  for (uint32_t at = 0; at < merge->count; at++) {
    merge->prepared = at + 1;
    napi_value value = NULL;
    if (napi_get_element(env, list, at, &value) != napi_ok || !prepare_merge_input(env, value, merge->handles + at)) {
      return merge->handles[at].out_of_memory ? NARSIL_OUT_OF_MEMORY : NARSIL_INVALID_ARGUMENT;
    }
  }
  return NARSIL_OK;
}

static narsil_status read_inputs(napi_env env, node_merge *merge) {
  for (size_t at = 0; at < merge->count; at++) {
    if (!read_merge_input(env, merge->handles + at, merge->inputs + at, merge->storage + at)) {
      return merge->storage[at].out_of_memory ? NARSIL_OUT_OF_MEMORY : NARSIL_INVALID_ARGUMENT;
    }
  }
  return NARSIL_OK;
}

static narsil_status apply(napi_env env, thread_state *thread, const napi_value *argv, node_merge *merge, int mode,
                           uint32_t *written) {
  uint32_t documents = 0;
  uint32_t fields = 0;
  merge_output_handles handles = {0};
  napi_value posting_handles[POSTING_OUTPUTS] = {0};
  napi_value retained_handles[MERGE_STRING_HANDLES] = {0};
  napi_valuetype retained_type = napi_undefined;
  if (argv[RETAINED_TERMS] != NULL && napi_typeof(env, argv[RETAINED_TERMS], &retained_type) != napi_ok) {
    return NARSIL_INVALID_ARGUMENT;
  }
  int retained = retained_type != napi_undefined && retained_type != napi_null;
  if (!segment_uint_argument(env, argv[DOCUMENTS], &documents) || !segment_uint_argument(env, argv[FIELDS], &fields) ||
      fields > (uint32_t)UINT16_MAX + 1 || (mode == 1 && !prepare_merge_output(env, argv[OUTPUT], &handles)) ||
      (mode == 2 && !prepare_posting_output(env, argv[OUTPUT], posting_handles)) ||
      (retained && (mode == 2 || !prepare_merge_strings(env, argv[RETAINED_TERMS], retained_handles)))) {
    return NARSIL_INVALID_ARGUMENT;
  }
  narsil_status status = read_inputs(env, merge);
  if (status != NARSIL_OK) { return status; }
  narsil_frozen_strings retained_terms = {0};
  if (retained && !read_merge_strings(env, retained_handles, 1, &retained_terms)) { return NARSIL_INVALID_ARGUMENT; }
  narsil_keyword_merge_request request = {merge->inputs, merge->count, documents, fields,
                                          retained ? &retained_terms : NULL};
  if (mode == 2) {
    narsil_posting_merge_output output = {0};
    if (!read_posting_output(env, posting_handles, &output)) { return NARSIL_INVALID_ARGUMENT; }
    return narsil_merge_postings(thread->workspace, &request, &output, written);
  }
  if (mode == 1) {
    narsil_keyword_merge_output output = {0};
    if (!read_merge_output(env, &handles, &output)) { return NARSIL_INVALID_ARGUMENT; }
    return narsil_write_merge(thread->workspace, &request, &output);
  }
  void *sizes = NULL;
  size_t count = 0;
  if (!possibly_empty_typed_data(env, argv[OUTPUT], napi_uint32_array, &sizes, &count) || count != MERGE_SIZE_WORDS) {
    return NARSIL_INVALID_ARGUMENT;
  }
  _Static_assert(sizeof(narsil_keyword_merge_sizes) == MERGE_SIZE_WORDS * sizeof(uint32_t), "merge size words");
  return narsil_measure_merge(thread->workspace, &request, sizes);
}

static napi_value merge(napi_env env, napi_callback_info info, int mode) {
  napi_value argv[MERGE_ARGUMENTS] = {0};
  size_t argc = MERGE_ARGUMENTS;
  thread_state *thread = thread_state_of(env);
  if (thread == NULL || napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < RETAINED_TERMS) {
    return number_of(env, mode == 2 ? -(int32_t)NARSIL_INVALID_ARGUMENT : (int32_t)NARSIL_INVALID_ARGUMENT);
  }
  node_merge data = {0};
  uint32_t written = 0;
  narsil_status status = prepare(env, argv[INPUTS], &data);
  if (status == NARSIL_OK) { status = apply(env, thread, argv, &data, mode, &written); }
  release(&data);
  report_workspace_memory(env, thread);
  if (mode == 2) {
    napi_value result = NULL;
    double value = status == NARSIL_OK ? (double)written : -(double)status;
    if (napi_create_double(env, value, &result) != napi_ok) { return NULL; }
    return result;
  }
  return status_of(env, status);
}

static napi_value measure_merge(napi_env env, napi_callback_info info) { return merge(env, info, 0); }
static napi_value write_merge(napi_env env, napi_callback_info info) { return merge(env, info, 1); }
static napi_value merge_postings(napi_env env, napi_callback_info info) { return merge(env, info, 2); }

int define_segment_merges(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"measureMerge", NULL, measure_merge, NULL, NULL, NULL, napi_default_method, NULL},
      {"writeMerge", NULL, write_merge, NULL, NULL, NULL, napi_default_method, NULL},
      {"mergePostings", NULL, merge_postings, NULL, NULL, NULL, napi_default_method, NULL},
  };
  return napi_define_properties(env, exports, sizeof properties / sizeof properties[0], properties) == napi_ok;
}
