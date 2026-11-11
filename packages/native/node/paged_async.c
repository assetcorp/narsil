#include "paged_async.h"

#include "../include/narsil_core.h"
#include "../include/narsil_paged.h"
#include "../include/narsil_paged_vectors.h"
#include "paged.h"
#include "paged_vectors.h"
#include "values.h"
#include <js_native_api.h>
#include <js_native_api_types.h>
#include <node_api.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

static void execute(napi_env env, void *data) {
  (void)env;
  paged_async_job *job = data;
  if (job->reads_page) {
    job->status = narsil_read_page(job->workspace, &job->cache, &job->section, job->page, job->page_output,
                                   job->page_capacity, job->fault);
    return;
  }
  job->status = narsil_search_paged_vectors(job->workspace, &job->cache, &job->field, &job->request, &job->output,
                                            &job->count, job->fault);
}

static void complete(napi_env env, napi_status status, void *data) {
  paged_async_job *job = data;
  if (status != napi_ok) { job->status = NARSIL_STOPPED; }
  napi_value result = NULL;
  if (job->status == NARSIL_OK) {
    (void)napi_create_uint32(env, job->count, &result);
  } else {
    result = number_of(env, -(int32_t)job->status);
  }
  if (result != NULL) { (void)napi_resolve_deferred(env, job->deferred, result); }
  release_paged_async(env, job);
}

static narsil_status prepare(napi_env env, paged_async_job *job, const napi_value *argv) {
  paged_field_handles field = {0};
  paged_query_handles query = {0};
  page_cache_handles cache = {0};
  narsil_status status = prepare_paged_field(env, argv[PAGED_FIELD], &field);
  if (status == NARSIL_OK && (!prepare_paged_query(env, argv[PAGED_REQUEST], &query) ||
                              !prepare_page_cache_handles(env, argv[PAGED_CACHE], &cache) ||
                              !retain_paged_inputs(env, job, argv, &field, &cache))) {
    status = NARSIL_INVALID_ARGUMENT;
  }
  if (status == NARSIL_OK) {
    status = read_paged_search(env, argv, &field, &query, &cache, &job->cache, &job->output, &job->fault, &job->count);
  }
  if (status == NARSIL_OK) { status = copy_paged_inputs(job, &field.field, &query.request); }
  release_paged_field(&field);
  return status;
}

napi_value queue_paged_async(napi_env env, paged_async_job *job) {
  narsil_status status = narsil_workspace_create(&job->workspace);
  if (status != NARSIL_OK) {
    release_paged_async(env, job);
    return number_of(env, -(int32_t)status);
  }
  napi_value label = NULL;
  napi_value promise = NULL;
  const char *operation = job->reads_page ? "narsil.readPage" : "narsil.searchPagedVectors";
  if (napi_create_string_utf8(env, operation, NAPI_AUTO_LENGTH, &label) != napi_ok ||
      napi_create_async_work(env, NULL, label, execute, complete, job, &job->work) != napi_ok ||
      napi_create_promise(env, &job->deferred, &promise) != napi_ok) {
    release_paged_async(env, job);
    return NULL;
  }
  if (napi_queue_async_work(env, job->work) != napi_ok) {
    napi_value refused = number_of(env, -NARSIL_OUT_OF_MEMORY);
    if (refused != NULL) { (void)napi_resolve_deferred(env, job->deferred, refused); }
    release_paged_async(env, job);
  }
  return promise;
}

static napi_value search(napi_env env, napi_callback_info info) {
  napi_value argv[PAGED_ARGUMENTS];
  if (!callback_arguments(env, info, PAGED_ARGUMENTS, argv)) { return number_of(env, -NARSIL_INVALID_ARGUMENT); }
  paged_async_job *job = calloc(1, sizeof *job);
  if (job == NULL) { return number_of(env, -NARSIL_OUT_OF_MEMORY); }
  narsil_status status = prepare(env, job, argv);
  if (status != NARSIL_OK) {
    release_paged_async(env, job);
    return number_of(env, -(int32_t)status);
  }
  return queue_paged_async(env, job);
}

int define_paged_async(napi_env env, napi_value exports) {
  napi_property_descriptor property = {"searchPagedVectorsAsync", NULL, search, NULL, NULL, NULL,
                                       napi_default_method,       NULL};
  return napi_define_properties(env, exports, 1, &property) == napi_ok && define_paged_page_async(env, exports);
}
