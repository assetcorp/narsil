#include "paged.h"

#include "../include/narsil_paged.h"
#include "values.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <math.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

static const char *const PAGE_KEYS[] = {"file", "offset", "length", "pageBytes", "checksums"};
static const char *const CACHE_KEYS[] = {"bytes", "files", "offsets", "pages", "lengths", "checksums"};

int paged_uint64(napi_env env, napi_value value, uint64_t *number) {
  bool lossless = false;
  return napi_get_value_bigint_uint64(env, value, number, &lossless) == napi_ok && lossless;
}

int prepare_page_handles(napi_env env, napi_value value, page_handles *handles) {
  for (size_t index = 0; index < PAGE_PROPERTIES; index++) {
    if (napi_get_named_property(env, value, PAGE_KEYS[index], &handles->values[index]) != napi_ok) { return 0; }
  }
  double page_bytes = 0;
  if (!paged_uint64(env, handles->values[PAGE_OFFSET], &handles->offset) ||
      !paged_uint64(env, handles->values[PAGE_LENGTH], &handles->length) ||
      napi_get_value_double(env, handles->values[PAGE_BYTES], &page_bytes) != napi_ok || !isfinite(page_bytes) ||
      page_bytes < 0 || page_bytes > UINT32_MAX || floor(page_bytes) != page_bytes) {
    return 0;
  }
  handles->page_bytes = (uint32_t)page_bytes;
  return 1;
}

int read_page_handles(napi_env env, const page_handles *handles, narsil_page_section *section) {
  attached_paged_file *attached = paged_file_handle(env, handles->values[PAGE_FILE]);
  void *checksums = NULL;
  size_t count = 0;
  if (attached == NULL || attached->closed || attached->file == NULL ||
      !possibly_empty_typed_data(env, handles->values[PAGE_CHECKSUMS], napi_uint8_array, &checksums, &count)) {
    return 0;
  }
  *section =
      (narsil_page_section){attached->file, handles->offset, handles->length, handles->page_bytes, checksums, count};
  return 1;
}

int prepare_page_cache_handles(napi_env env, napi_value value, page_cache_handles *handles) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok) { return 0; }
  handles->present = type != napi_null;
  if (!handles->present) { return 1; }
  for (size_t index = 0; index < CACHE_PROPERTIES; index++) {
    if (napi_get_named_property(env, value, CACHE_KEYS[index], &handles->values[index]) != napi_ok) { return 0; }
  }
  return 1;
}

int read_page_cache_handles(napi_env env, const page_cache_handles *handles, narsil_page_cache *cache) {
  if (!handles->present) { return 1; }
  void *data[CACHE_PROPERTIES] = {0};
  size_t lengths[CACHE_PROPERTIES] = {0};
  for (size_t index = 0; index < CACHE_PROPERTIES; index++) {
    napi_typedarray_type type = napi_biguint64_array;
    if (index == CACHE_BYTES) {
      type = napi_uint8_array;
    } else if (index >= CACHE_LENGTHS) {
      type = napi_uint32_array;
    }
    if (!possibly_empty_typed_data(env, handles->values[index], type, &data[index], &lengths[index])) { return 0; }
    if (index > CACHE_FILES && lengths[index] != lengths[CACHE_FILES]) { return 0; }
  }
  *cache = (narsil_page_cache){data[CACHE_BYTES], lengths[CACHE_BYTES], data[CACHE_FILES],     data[CACHE_OFFSETS],
                               data[CACHE_PAGES], data[CACHE_LENGTHS],  data[CACHE_CHECKSUMS], lengths[CACHE_FILES]};
  return 1;
}
