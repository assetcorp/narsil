#ifndef NARSIL_NODE_PAGED_ASYNC_H
#define NARSIL_NODE_PAGED_ASYNC_H

#include "../include/narsil_core.h"
#include "../include/narsil_paged.h"
#include "../include/narsil_paged_vectors.h"
#include "paged_vectors.h"
#include <node_api.h>
#include <stddef.h>
#include <stdint.h>

enum {
  PAGED_FIELD,
  PAGED_REQUEST,
  PAGED_CACHE,
  PAGED_METER,
  PAGED_STOP,
  PAGED_DEADLINE,
  PAGED_ORDINALS,
  PAGED_SCORES,
  PAGED_FAULT,
  PAGED_ARGUMENTS
};

typedef struct paged_owned {
  void *bytes;
  struct paged_owned *next;
} paged_owned;

typedef struct paged_retained {
  napi_ref reference;
  attached_paged_file *file;
  struct paged_retained *next;
} paged_retained;

typedef struct {
  napi_async_work work;
  napi_deferred deferred;
  narsil_workspace *workspace;
  narsil_page_cache cache;
  narsil_paged_vector_field field;
  narsil_paged_vector_request request;
  narsil_paged_vector_output output;
  narsil_page_fault *fault;
  uint32_t count;
  narsil_status status;
  int reads_page;
  narsil_page_section section;
  uint64_t page;
  uint8_t *page_output;
  size_t page_capacity;
  paged_owned *owned;
  paged_retained *retained;
} paged_async_job;

narsil_status read_paged_search(napi_env env, const napi_value *argv, paged_field_handles *field,
                                paged_query_handles *query, const page_cache_handles *cache_handles,
                                narsil_page_cache *cache, narsil_paged_vector_output *output, narsil_page_fault **fault,
                                uint32_t *count);
narsil_status copy_paged_inputs(paged_async_job *job, const narsil_paged_vector_field *field,
                                const narsil_paged_vector_request *request);
int retain_paged_inputs(napi_env env, paged_async_job *job, const napi_value *argv, const paged_field_handles *field,
                        const page_cache_handles *cache);
int retain_paged_shared(napi_env env, paged_async_job *job, napi_value value);
int retain_paged_file(napi_env env, paged_async_job *job, const page_handles *section);
int copy_paged_section(paged_async_job *job, narsil_page_section *section);
int define_paged_page_async(napi_env env, napi_value exports);
napi_value queue_paged_async(napi_env env, paged_async_job *job);
void release_paged_async(napi_env env, paged_async_job *job);
int define_paged_async(napi_env env, napi_value exports);

#endif
