#include "paged.h"

#include "../include/narsil_core.h"
#include "../include/narsil_paged.h"
#include "paged_vectors.h"
#include "values.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <stddef.h>
#include <stdint.h>

enum { SECTION, CACHE, PAGE, OUTPUT, FAULT, ARGUMENT_COUNT };
enum { FAULT_WORDS = 3 };

static napi_value read_page(napi_env env, napi_callback_info info) {
  napi_value argv[ARGUMENT_COUNT];
  thread_state *state = thread_state_of(env);
  page_handles section_handles = {0};
  page_cache_handles cache_handles = {0};
  uint64_t page = 0;
  if (state == NULL || !callback_arguments(env, info, ARGUMENT_COUNT, argv) ||
      !prepare_page_handles(env, argv[SECTION], &section_handles) ||
      !prepare_page_cache_handles(env, argv[CACHE], &cache_handles) || !paged_uint64(env, argv[PAGE], &page)) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  narsil_page_section section = {0};
  narsil_page_cache cache = {0};
  void *output = NULL;
  void *fault = NULL;
  size_t capacity = 0;
  size_t fault_words = 0;
  if (!read_page_handles(env, &section_handles, &section) || !read_page_cache_handles(env, &cache_handles, &cache) ||
      !possibly_empty_typed_data(env, argv[OUTPUT], napi_uint8_array, &output, &capacity) ||
      !typed_data(env, argv[FAULT], napi_biguint64_array, &fault, &fault_words) || fault_words != FAULT_WORDS) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  narsil_status status = narsil_read_page(state->workspace, cache_handles.present ? &cache : NULL, &section, page,
                                          output, capacity, fault);
  report_workspace_memory(env, state);
  return number_of(env, -(int32_t)status);
}

static napi_value read_postings(napi_env env, napi_callback_info info) {
  enum {
    POSTINGS_SECTION,
    POSTINGS_CACHE,
    FIRST,
    COUNT,
    DOCUMENTS,
    FIELDS,
    POSTINGS_OUTPUT,
    POSTINGS_FAULT,
    ARGUMENTS
  };
  napi_value argv[ARGUMENTS];
  thread_state *state = thread_state_of(env);
  page_handles section_handles = {0};
  page_cache_handles cache_handles = {0};
  uint32_t first = 0;
  uint32_t count = 0;
  uint32_t documents = 0;
  uint32_t fields = 0;
  if (state == NULL || !callback_arguments(env, info, ARGUMENTS, argv) ||
      !prepare_page_handles(env, argv[POSTINGS_SECTION], &section_handles) ||
      !prepare_page_cache_handles(env, argv[POSTINGS_CACHE], &cache_handles) ||
      !paged_uint32(env, argv[FIRST], &first) || !paged_uint32(env, argv[COUNT], &count) ||
      !paged_uint32(env, argv[DOCUMENTS], &documents) || !paged_uint32(env, argv[FIELDS], &fields)) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  narsil_page_section section = {0};
  narsil_page_cache cache = {0};
  void *output = NULL;
  void *fault = NULL;
  size_t capacity = 0;
  size_t fault_words = 0;
  if (!read_page_handles(env, &section_handles, &section) || !read_page_cache_handles(env, &cache_handles, &cache) ||
      !possibly_empty_typed_data(env, argv[POSTINGS_OUTPUT], napi_uint8_array, &output, &capacity) ||
      !typed_data(env, argv[POSTINGS_FAULT], napi_biguint64_array, &fault, &fault_words) ||
      fault_words != FAULT_WORDS) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  narsil_status status =
      narsil_read_paged_postings(state->workspace, cache_handles.present ? &cache : NULL, &section,
                                 (narsil_paged_posting_list){first, count, documents, fields}, output, capacity, fault);
  report_workspace_memory(env, state);
  return number_of(env, -(int32_t)status);
}

static napi_value read_positions(napi_env env, napi_callback_info info) {
  enum { OFFSET_SECTION, VALUE_SECTION, PAGE_CACHE, FIRST, COUNT, OFFSETS, VALUES, PAGE_FAULT, ARGUMENTS };
  napi_value argv[ARGUMENTS];
  thread_state *state = thread_state_of(env);
  page_handles offset_handles = {0};
  page_handles value_handles = {0};
  page_cache_handles cache_handles = {0};
  uint32_t first = 0;
  uint32_t count = 0;
  if (state == NULL || !callback_arguments(env, info, ARGUMENTS, argv) ||
      !prepare_page_handles(env, argv[OFFSET_SECTION], &offset_handles) ||
      !prepare_page_handles(env, argv[VALUE_SECTION], &value_handles) ||
      !prepare_page_cache_handles(env, argv[PAGE_CACHE], &cache_handles) || !paged_uint32(env, argv[FIRST], &first) ||
      !paged_uint32(env, argv[COUNT], &count)) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  narsil_page_section offsets = {0};
  narsil_page_section values = {0};
  narsil_page_cache cache = {0};
  narsil_paged_position_output output = {0};
  void *out_offsets = NULL;
  void *out_values = NULL;
  void *fault = NULL;
  size_t fault_words = 0;
  if (!read_page_handles(env, &offset_handles, &offsets) || !read_page_handles(env, &value_handles, &values) ||
      !read_page_cache_handles(env, &cache_handles, &cache) ||
      !possibly_empty_typed_data(env, argv[OFFSETS], napi_uint32_array, &out_offsets, &output.offset_capacity) ||
      !possibly_empty_typed_data(env, argv[VALUES], napi_uint32_array, &out_values, &output.value_capacity) ||
      !typed_data(env, argv[PAGE_FAULT], napi_biguint64_array, &fault, &fault_words) || fault_words != FAULT_WORDS) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  output.offsets = out_offsets;
  output.values = out_values;
  narsil_status status =
      narsil_read_paged_positions(state->workspace, cache_handles.present ? &cache : NULL,
                                  (narsil_paged_position_list){&offsets, &values, first, count}, output, fault);
  report_workspace_memory(env, state);
  return number_of(env, -(int32_t)status);
}

static napi_value read_removals(napi_env env, napi_callback_info info) {
  enum { OFFSET_SECTION, VALUE_SECTION, PAGE_CACHE, ORDINAL, TOKENS, VALUES, PAGE_FAULT, ARGUMENTS };
  napi_value argv[ARGUMENTS];
  thread_state *state = thread_state_of(env);
  page_handles offset_handles = {0};
  page_handles value_handles = {0};
  page_cache_handles cache_handles = {0};
  uint32_t ordinal = 0;
  uint32_t tokens = 0;
  if (state == NULL || !callback_arguments(env, info, ARGUMENTS, argv) ||
      !prepare_page_handles(env, argv[OFFSET_SECTION], &offset_handles) ||
      !prepare_page_handles(env, argv[VALUE_SECTION], &value_handles) ||
      !prepare_page_cache_handles(env, argv[PAGE_CACHE], &cache_handles) ||
      !paged_uint32(env, argv[ORDINAL], &ordinal) || !paged_uint32(env, argv[TOKENS], &tokens)) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  narsil_page_section offsets = {0};
  narsil_page_section values = {0};
  narsil_page_cache cache = {0};
  void *output = NULL;
  void *fault = NULL;
  size_t capacity = 0;
  size_t fault_words = 0;
  if (!read_page_handles(env, &offset_handles, &offsets) || !read_page_handles(env, &value_handles, &values) ||
      !read_page_cache_handles(env, &cache_handles, &cache) ||
      !possibly_empty_typed_data(env, argv[VALUES], napi_uint32_array, &output, &capacity) ||
      !typed_data(env, argv[PAGE_FAULT], napi_biguint64_array, &fault, &fault_words) || fault_words != FAULT_WORDS) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  uint32_t count = 0;
  narsil_status status = narsil_read_paged_removals(state->workspace, cache_handles.present ? &cache : NULL,
                                                    (narsil_paged_removal_list){&offsets, &values, ordinal, tokens},
                                                    (narsil_paged_removal_output){output, capacity, &count}, fault);
  report_workspace_memory(env, state);
  if (status != NARSIL_OK) { return number_of(env, -(int32_t)status); }
  napi_value result = NULL;
  return napi_create_uint32(env, count, &result) == napi_ok ? result : NULL;
}

int define_paged_reads(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"readPage", NULL, read_page, NULL, NULL, NULL, napi_default_method, NULL},
      {"readPagedPostings", NULL, read_postings, NULL, NULL, NULL, napi_default_method, NULL},
      {"readPagedPositions", NULL, read_positions, NULL, NULL, NULL, napi_default_method, NULL},
      {"readPagedRemovals", NULL, read_removals, NULL, NULL, NULL, napi_default_method, NULL}};
  return napi_define_properties(env, exports, sizeof properties / sizeof properties[0], properties) == napi_ok &&
         define_paged_ids(env, exports);
}
