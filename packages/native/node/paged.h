#ifndef NARSIL_NODE_PAGED_H
#define NARSIL_NODE_PAGED_H

#include "../include/narsil_paged.h"

#include <js_native_api.h>
#include <stddef.h>
#include <stdint.h>

enum { PAGE_FILE, PAGE_OFFSET, PAGE_LENGTH, PAGE_BYTES, PAGE_CHECKSUMS, PAGE_PROPERTIES };
enum { CACHE_BYTES, CACHE_FILES, CACHE_OFFSETS, CACHE_PAGES, CACHE_LENGTHS, CACHE_CHECKSUMS, CACHE_PROPERTIES };

typedef struct {
  narsil_paged_file *file;
  size_t pending;
  int closed;
} attached_paged_file;

typedef struct {
  napi_value values[PAGE_PROPERTIES];
  uint64_t offset;
  uint64_t length;
  uint32_t page_bytes;
} page_handles;

typedef struct {
  napi_value values[CACHE_PROPERTIES];
  int present;
} page_cache_handles;

int define_paged_files(napi_env env, napi_value exports);
int define_paged_reads(napi_env env, napi_value exports);
int define_paged_ids(napi_env env, napi_value exports);
attached_paged_file *paged_file_handle(napi_env env, napi_value value);
int prepare_page_handles(napi_env env, napi_value value, page_handles *handles);
int read_page_handles(napi_env env, const page_handles *handles, narsil_page_section *section);
int prepare_page_cache_handles(napi_env env, napi_value value, page_cache_handles *handles);
int read_page_cache_handles(napi_env env, const page_cache_handles *handles, narsil_page_cache *cache);
int paged_uint64(napi_env env, napi_value value, uint64_t *number);

#endif
