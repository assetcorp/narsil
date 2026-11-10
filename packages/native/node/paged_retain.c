#include "paged_async.h"

#include "../include/narsil_core.h"
#include "../include/narsil_paged.h"
#include "paged.h"
#include "paged_vectors.h"
#include <js_native_api.h>
#include <js_native_api_types.h>
#include <node_api.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

static int retain(napi_env env, paged_async_job *job, napi_value value, attached_paged_file *file) {
  paged_retained *entry = calloc(1, sizeof *entry);
  if (entry == NULL) { return 0; }
  if (napi_create_reference(env, value, 1, &entry->reference) != napi_ok) {
    free(entry);
    return 0;
  }
  entry->file = file;
  if (file != NULL) { file->pending++; }
  entry->next = job->retained;
  job->retained = entry;
  return 1;
}

int retain_paged_shared(napi_env env, paged_async_job *job, napi_value value) {
  napi_value buffer = NULL;
  bool detachable = true;
  if (napi_get_typedarray_info(env, value, NULL, NULL, NULL, &buffer, NULL) != napi_ok ||
      napi_is_arraybuffer(env, buffer, &detachable) != napi_ok || detachable) {
    return 0;
  }
  return retain(env, job, value, NULL);
}

int retain_paged_file(napi_env env, paged_async_job *job, const page_handles *section) {
  napi_value value = section->values[PAGE_FILE];
  attached_paged_file *file = paged_file_handle(env, value);
  return file != NULL && !file->closed && file->file != NULL && file->pending < SIZE_MAX &&
         retain(env, job, value, file);
}

int retain_paged_inputs(napi_env env, paged_async_job *job, const napi_value *argv, const paged_field_handles *field,
                        const page_cache_handles *cache) {
  for (size_t at = PAGED_METER; at < PAGED_ARGUMENTS; at++) {
    if (at != PAGED_DEADLINE && !retain_paged_shared(env, job, argv[at])) { return 0; }
  }
  if (cache->present) {
    for (size_t at = 0; at < CACHE_PROPERTIES; at++) {
      if (!retain_paged_shared(env, job, cache->values[at])) { return 0; }
    }
  }
  for (size_t at = 0; at < field->field.file_count; at++) {
    const vector_file_handles *file = &field->file_handles[at];
    if (!retain_paged_file(env, job, &file->vectors) ||
        (file->has_records && !retain_paged_file(env, job, &file->records))) {
      return 0;
    }
  }
  for (size_t at = 0; at < field->field.part_count; at++) {
    if (!retain_paged_file(env, job, &field->part_handles[at].neighbours)) { return 0; }
  }
  return 1;
}

void release_paged_async(napi_env env, paged_async_job *job) {
  if (job == NULL) { return; }
  if (job->work != NULL) { (void)napi_delete_async_work(env, job->work); }
  while (job->retained != NULL) {
    paged_retained *entry = job->retained;
    job->retained = entry->next;
    if (entry->file != NULL) {
      entry->file->pending--;
      if (entry->file->pending == 0 && entry->file->closed) {
        narsil_paged_file_close(entry->file->file);
        entry->file->file = NULL;
      }
    }
    (void)napi_delete_reference(env, entry->reference);
    free(entry);
  }
  while (job->owned != NULL) {
    paged_owned *entry = job->owned;
    job->owned = entry->next;
    free(entry->bytes);
    free(entry);
  }
  narsil_workspace_destroy(job->workspace);
  free(job);
}
