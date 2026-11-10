#include "paged_vectors.h"

#include "../include/narsil_core.h"
#include "../include/narsil_paged.h"
#include "../include/narsil_paged_vectors.h"
#include "../include/narsil_work.h"
#include "../src/paged_vectors/internal.h"
#include "../src/segments/regions.h"
#include "paged.h"
#include "paged_async.h"
#include "values.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <stddef.h>
#include <stdint.h>

enum { FIELD, REQUEST, CACHE, METER, STOP, DEADLINE, ORDINALS, SCORES, FAULT, ARGUMENT_COUNT };
enum { FAULT_WORDS = 3 };

narsil_status read_paged_search(napi_env env, const napi_value *argv, paged_field_handles *field,
                                paged_query_handles *query, const page_cache_handles *cache_handles,
                                narsil_page_cache *cache, narsil_paged_vector_output *output, narsil_page_fault **fault,
                                uint32_t *count) {
  void *data[ARGUMENT_COUNT] = {0};
  size_t lengths[ARGUMENT_COUNT] = {0};
  if (!read_paged_field(env, field) || !read_paged_query(env, query) ||
      !read_page_cache_handles(env, cache_handles, cache)) {
    return NARSIL_INVALID_ARGUMENT;
  }
  for (size_t at = METER; at < ARGUMENT_COUNT; at++) {
    napi_typedarray_type type = napi_uint32_array;
    if (at == METER) { type = napi_bigint64_array; }
    if (at == DEADLINE || at == FAULT) { type = napi_biguint64_array; }
    if (at == SCORES) { type = napi_float64_array; }
    if (!possibly_empty_typed_data(env, argv[at], type, &data[at], &lengths[at])) { return NARSIL_INVALID_ARGUMENT; }
  }
  if (lengths[METER] != 2 || lengths[STOP] != 1 || lengths[DEADLINE] != 1 || lengths[FAULT] != FAULT_WORDS) {
    return NARSIL_INVALID_ARGUMENT;
  }
  int64_t *meter = data[METER];
  const uint64_t *deadline = data[DEADLINE];
  query->request.meter = (narsil_work_meter){meter, meter[1], data[STOP], deadline[0]};
  *output = (narsil_paged_vector_output){data[ORDINALS], lengths[ORDINALS], data[SCORES], lengths[SCORES]};
  *fault = data[FAULT];
  narsil_page_cache *held_cache = cache_handles->present ? cache : NULL;
  segment_regions regions = {0};
  if (!paged_vector_regions(&regions, held_cache, &field->field, &query->request, output, count, *fault) ||
      !segment_region_input(&regions, meter + 1, 1, sizeof *meter) ||
      !segment_region_input(&regions, deadline, 1, sizeof *deadline)) {
    return NARSIL_INVALID_ARGUMENT;
  }
  return paged_vector_validate(&regions, &field->field, &query->request, *fault);
}

static napi_value search(napi_env env, napi_callback_info info) {
  napi_value argv[ARGUMENT_COUNT];
  thread_state *state = thread_state_of(env);
  if (state == NULL || !callback_arguments(env, info, ARGUMENT_COUNT, argv)) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  paged_field_handles field = {0};
  paged_query_handles query = {0};
  page_cache_handles cache = {0};
  narsil_status status = prepare_paged_field(env, argv[FIELD], &field);
  if (status == NARSIL_OK &&
      (!prepare_paged_query(env, argv[REQUEST], &query) || !prepare_page_cache_handles(env, argv[CACHE], &cache))) {
    status = NARSIL_INVALID_ARGUMENT;
  }
  uint32_t count = 0;
  narsil_page_cache pages = {0};
  narsil_paged_vector_output output = {0};
  narsil_page_fault *fault = NULL;
  if (status == NARSIL_OK) {
    status = read_paged_search(env, argv, &field, &query, &cache, &pages, &output, &fault, &count);
  }
  if (status == NARSIL_OK) {
    status = narsil_search_paged_vectors(state->workspace, cache.present ? &pages : NULL, &field.field, &query.request,
                                         &output, &count, fault);
  }
  release_paged_field(&field);
  report_workspace_memory(env, state);
  if (status != NARSIL_OK) { return number_of(env, -(int32_t)status); }
  napi_value result = NULL;
  return napi_create_uint32(env, count, &result) == napi_ok ? result : NULL;
}

int define_paged_vectors(napi_env env, napi_value exports) {
  napi_property_descriptor property = {"searchPagedVectors", NULL, search, NULL, NULL, NULL, napi_default_method, NULL};
  return napi_define_properties(env, exports, 1, &property) == napi_ok && define_paged_async(env, exports);
}
