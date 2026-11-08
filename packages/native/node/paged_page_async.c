#include "paged_async.h"

#include "../include/narsil_core.h"
#include "../src/paged/cache.h"
#include "paged.h"
#include "values.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

enum { SECTION, CACHE, PAGE, OUTPUT, FAULT, ARGUMENTS };
enum { FAULT_WORDS = 3 };

static narsil_status prepare(napi_env env, paged_async_job *job, const napi_value *argv) {
  page_handles section = {0};
  page_cache_handles cache = {0};
  if (!prepare_page_handles(env, argv[SECTION], &section) || !prepare_page_cache_handles(env, argv[CACHE], &cache) ||
      !paged_uint64(env, argv[PAGE], &job->page) || !retain_paged_file(env, job, &section) ||
      !retain_paged_shared(env, job, argv[OUTPUT]) || !retain_paged_shared(env, job, argv[FAULT])) {
    return NARSIL_INVALID_ARGUMENT;
  }
  if (cache.present) {
    for (size_t at = 0; at < CACHE_PROPERTIES; at++) {
      if (!retain_paged_shared(env, job, cache.values[at])) { return NARSIL_INVALID_ARGUMENT; }
    }
  }
  void *output = NULL;
  void *fault = NULL;
  size_t fault_words = 0;
  if (!read_page_handles(env, &section, &job->section) || !read_page_cache_handles(env, &cache, &job->cache) ||
      !possibly_empty_typed_data(env, argv[OUTPUT], napi_uint8_array, &output, &job->page_capacity) ||
      !typed_data(env, argv[FAULT], napi_biguint64_array, &fault, &fault_words) || fault_words != FAULT_WORDS ||
      !paged_regions(&job->cache, &job->section, output, job->page_capacity, fault)) {
    return NARSIL_INVALID_ARGUMENT;
  }
  job->page_output = output;
  job->fault = fault;
  job->reads_page = 1;
  return copy_paged_section(job, &job->section) ? NARSIL_OK : NARSIL_OUT_OF_MEMORY;
}

static napi_value read_page(napi_env env, napi_callback_info info) {
  napi_value argv[ARGUMENTS];
  if (!callback_arguments(env, info, ARGUMENTS, argv)) { return number_of(env, -NARSIL_INVALID_ARGUMENT); }
  paged_async_job *job = calloc(1, sizeof *job);
  if (job == NULL) { return number_of(env, -NARSIL_OUT_OF_MEMORY); }
  narsil_status status = prepare(env, job, argv);
  if (status != NARSIL_OK) {
    release_paged_async(env, job);
    return number_of(env, -(int32_t)status);
  }
  return queue_paged_async(env, job);
}

int define_paged_page_async(napi_env env, napi_value exports) {
  napi_property_descriptor property = {"readPageAsync", NULL, read_page, NULL, NULL, NULL, napi_default_method, NULL};
  return napi_define_properties(env, exports, 1, &property) == napi_ok;
}
