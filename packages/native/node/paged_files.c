#include "paged.h"

#include "../include/narsil_core.h"
#include "../include/narsil_paged.h"
#include "values.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

static const napi_type_tag FILE_TAG = {UINT64_C(0x32ca2e0a47374353), UINT64_C(0xb69b0180e09a7925)};

static void release(napi_env env, void *finalize_data, void *finalize_hint) {
  (void)env;
  (void)finalize_hint;
  attached_paged_file *attached = finalize_data;
  narsil_paged_file_close(attached->file);
  free(attached);
}

attached_paged_file *paged_file_handle(napi_env env, napi_value value) {
  bool matches = false;
  void *data = NULL;
  if (napi_check_object_type_tag(env, value, &FILE_TAG, &matches) != napi_ok || !matches ||
      napi_unwrap(env, value, &data) != napi_ok || data == NULL) {
    return NULL;
  }
  return data;
}

static napi_value open_file(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  size_t length = 0;
  if (!callback_arguments(env, info, 1, argv) ||
      napi_get_value_string_utf8(env, argv[0], NULL, 0, &length) != napi_ok || length == SIZE_MAX) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  char *path = calloc(length + 1, 1);
  attached_paged_file *attached = calloc(1, sizeof *attached);
  if (path == NULL || attached == NULL) {
    free(path);
    free(attached);
    return number_of(env, -NARSIL_OUT_OF_MEMORY);
  }
  size_t received = 0;
  narsil_status status = NARSIL_INVALID_ARGUMENT;
  if (napi_get_value_string_utf8(env, argv[0], path, length + 1, &received) == napi_ok && received == length &&
      memchr(path, 0, length) == NULL) {
    status = narsil_paged_file_open(path, &attached->file);
  }
  free(path);
  if (status != NARSIL_OK) {
    free(attached);
    return number_of(env, -(int32_t)status);
  }
  napi_value result = NULL;
  napi_value identity = NULL;
  napi_value file_length = NULL;
  if (napi_create_object(env, &result) != napi_ok ||
      napi_create_bigint_uint64(env, narsil_paged_file_identity(attached->file), &identity) != napi_ok ||
      napi_create_bigint_uint64(env, narsil_paged_file_length(attached->file), &file_length) != napi_ok) {
    release(env, attached, NULL);
    return NULL;
  }
  napi_property_descriptor properties[] = {{"identity", NULL, NULL, NULL, NULL, identity, napi_enumerable, NULL},
                                           {"length", NULL, NULL, NULL, NULL, file_length, napi_enumerable, NULL}};
  if (napi_define_properties(env, result, sizeof properties / sizeof properties[0], properties) != napi_ok ||
      napi_type_tag_object(env, result, &FILE_TAG) != napi_ok ||
      napi_wrap(env, result, attached, release, NULL, NULL) != napi_ok) {
    release(env, attached, NULL);
    return NULL;
  }
  return result;
}

static napi_value close_file(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  if (!callback_arguments(env, info, 1, argv)) { return number_of(env, -NARSIL_INVALID_ARGUMENT); }
  attached_paged_file *attached = paged_file_handle(env, argv[0]);
  if (attached == NULL) { return number_of(env, -NARSIL_INVALID_ARGUMENT); }
  attached->closed = 1;
  if (attached->pending == 0) {
    narsil_paged_file_close(attached->file);
    attached->file = NULL;
  }
  return number_of(env, 0);
}

int define_paged_files(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"openPagedFile", NULL, open_file, NULL, NULL, NULL, napi_default_method, NULL},
      {"closePagedFile", NULL, close_file, NULL, NULL, NULL, napi_default_method, NULL}};
  return napi_define_properties(env, exports, sizeof properties / sizeof properties[0], properties) == napi_ok;
}
