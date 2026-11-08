#include "paged.h"

#include "../include/narsil_core.h"
#include "../include/narsil_paged.h"
#include "paged_vectors.h"
#include "values.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <stddef.h>
#include <stdint.h>

static napi_value read_id(napi_env env, napi_callback_info info) {
  enum { OFFSET_SECTION, VALUE_SECTION, PAGE_CACHE, ORDINAL, OUTPUT, PAGE_FAULT, ARGUMENTS };
  napi_value argv[ARGUMENTS];
  thread_state *state = thread_state_of(env);
  page_handles offset_handles = {0};
  page_handles value_handles = {0};
  page_cache_handles cache_handles = {0};
  uint32_t ordinal = 0;
  if (state == NULL || !callback_arguments(env, info, ARGUMENTS, argv) ||
      !prepare_page_handles(env, argv[OFFSET_SECTION], &offset_handles) ||
      !prepare_page_handles(env, argv[VALUE_SECTION], &value_handles) ||
      !prepare_page_cache_handles(env, argv[PAGE_CACHE], &cache_handles) ||
      !paged_uint32(env, argv[ORDINAL], &ordinal)) {
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
      !possibly_empty_typed_data(env, argv[OUTPUT], napi_uint8_array, &output, &capacity) ||
      !typed_data(env, argv[PAGE_FAULT], napi_biguint64_array, &fault, &fault_words) || fault_words != 3) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  uint32_t length = 0;
  narsil_status status = narsil_read_paged_id(state->workspace, cache_handles.present ? &cache : NULL,
                                              (narsil_paged_id_request){&offsets, &values, ordinal},
                                              (narsil_paged_id_output){output, capacity, &length}, fault);
  report_workspace_memory(env, state);
  if (status != NARSIL_OK) { return number_of(env, -(int32_t)status); }
  napi_value result = NULL;
  return napi_create_uint32(env, length, &result) == napi_ok ? result : NULL;
}

static napi_value read_ordinal(napi_env env, napi_callback_info info) {
  enum { SECTION, PAGE_CACHE, POSITION, DOCUMENTS, OUTPUT, PAGE_FAULT, ARGUMENTS };
  napi_value argv[ARGUMENTS];
  thread_state *state = thread_state_of(env);
  page_handles section_handles = {0};
  page_cache_handles cache_handles = {0};
  uint32_t position = 0;
  uint32_t documents = 0;
  if (state == NULL || !callback_arguments(env, info, ARGUMENTS, argv) ||
      !prepare_page_handles(env, argv[SECTION], &section_handles) ||
      !prepare_page_cache_handles(env, argv[PAGE_CACHE], &cache_handles) ||
      !paged_uint32(env, argv[POSITION], &position) || !paged_uint32(env, argv[DOCUMENTS], &documents)) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  narsil_page_section section = {0};
  narsil_page_cache cache = {0};
  void *output = NULL;
  void *fault = NULL;
  size_t capacity = 0;
  size_t fault_words = 0;
  if (!read_page_handles(env, &section_handles, &section) || !read_page_cache_handles(env, &cache_handles, &cache) ||
      !possibly_empty_typed_data(env, argv[OUTPUT], napi_uint32_array, &output, &capacity) ||
      !typed_data(env, argv[PAGE_FAULT], napi_biguint64_array, &fault, &fault_words) || fault_words != 3) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  narsil_status status =
      narsil_read_paged_ordinal(state->workspace, cache_handles.present ? &cache : NULL, &section,
                                (narsil_paged_ordinal_request){position, documents}, output, capacity, fault);
  report_workspace_memory(env, state);
  return number_of(env, -(int32_t)status);
}

static napi_value read_write_record(napi_env env, napi_callback_info info) {
  enum { SEQUENCES, TERMS, PAGE_CACHE, ORDINAL, OUTPUT, PAGE_FAULT, ARGUMENTS };
  napi_value argv[ARGUMENTS];
  thread_state *state = thread_state_of(env);
  page_handles sequence_handles = {0};
  page_handles term_handles = {0};
  page_cache_handles cache_handles = {0};
  uint32_t ordinal = 0;
  if (state == NULL || !callback_arguments(env, info, ARGUMENTS, argv) ||
      !prepare_page_handles(env, argv[SEQUENCES], &sequence_handles) ||
      !prepare_page_handles(env, argv[TERMS], &term_handles) ||
      !prepare_page_cache_handles(env, argv[PAGE_CACHE], &cache_handles) ||
      !paged_uint32(env, argv[ORDINAL], &ordinal)) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  narsil_page_section sequences = {0};
  narsil_page_section terms = {0};
  narsil_page_cache cache = {0};
  void *output = NULL;
  void *fault = NULL;
  size_t capacity = 0;
  size_t fault_words = 0;
  if (!read_page_handles(env, &sequence_handles, &sequences) || !read_page_handles(env, &term_handles, &terms) ||
      !read_page_cache_handles(env, &cache_handles, &cache) ||
      !possibly_empty_typed_data(env, argv[OUTPUT], napi_biguint64_array, &output, &capacity) ||
      !typed_data(env, argv[PAGE_FAULT], napi_biguint64_array, &fault, &fault_words) || fault_words != 3) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  narsil_status status = narsil_read_paged_write_record(state->workspace, cache_handles.present ? &cache : NULL,
                                                        (narsil_paged_write_request){&sequences, &terms, ordinal},
                                                        (narsil_paged_write_output){output, capacity}, fault);
  report_workspace_memory(env, state);
  return number_of(env, -(int32_t)status);
}

static napi_value read_totals(napi_env env, napi_callback_info info) {
  enum { SECTION, PAGE_CACHE, FIRST, COUNT, OUTPUT, PAGE_FAULT, ARGUMENTS };
  napi_value argv[ARGUMENTS];
  thread_state *state = thread_state_of(env);
  page_handles section_handles = {0};
  page_cache_handles cache_handles = {0};
  uint32_t first = 0;
  uint32_t count = 0;
  if (state == NULL || !callback_arguments(env, info, ARGUMENTS, argv) ||
      !prepare_page_handles(env, argv[SECTION], &section_handles) ||
      !prepare_page_cache_handles(env, argv[PAGE_CACHE], &cache_handles) || !paged_uint32(env, argv[FIRST], &first) ||
      !paged_uint32(env, argv[COUNT], &count)) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  narsil_page_section section = {0};
  narsil_page_cache cache = {0};
  void *output = NULL;
  void *fault = NULL;
  size_t capacity = 0;
  size_t fault_words = 0;
  if (!read_page_handles(env, &section_handles, &section) || !read_page_cache_handles(env, &cache_handles, &cache) ||
      !possibly_empty_typed_data(env, argv[OUTPUT], napi_float64_array, &output, &capacity) ||
      !typed_data(env, argv[PAGE_FAULT], napi_biguint64_array, &fault, &fault_words) || fault_words != 3) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  narsil_status status = narsil_read_paged_totals(state->workspace, cache_handles.present ? &cache : NULL, &section,
                                                  (narsil_paged_totals_request){first, count}, output, capacity, fault);
  report_workspace_memory(env, state);
  return number_of(env, -(int32_t)status);
}

int define_paged_ids(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"readPagedId", NULL, read_id, NULL, NULL, NULL, napi_default_method, NULL},
      {"readPagedOrdinal", NULL, read_ordinal, NULL, NULL, NULL, napi_default_method, NULL},
      {"readPagedTotals", NULL, read_totals, NULL, NULL, NULL, napi_default_method, NULL},
      {"readPagedWriteRecord", NULL, read_write_record, NULL, NULL, NULL, napi_default_method, NULL}};
  return napi_define_properties(env, exports, sizeof properties / sizeof properties[0], properties) == napi_ok;
}
