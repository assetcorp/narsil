#include "../include/narsil_core.h"
#include "../include/narsil_field_merge.h"
#include "segment_merge.h"
#include "segments.h"
#include "values.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

enum { KIND, SOURCES, DOCUMENTS, OUTPUT, ARGUMENTS };
enum { STORED_UNITS_REGION = 6, STORED_BYTES_REGION = 7 };

typedef struct {
  napi_value mapping;
  napi_value regions[NARSIL_FIELD_MERGE_REGIONS];
} field_handles_for_merge;

static size_t region_count(uint32_t kind) {
  const size_t counts[] = {0, 2, 2, 5, 4, 8, 4};
  return kind < sizeof counts / sizeof counts[0] ? counts[kind] : 0;
}

static napi_typedarray_type region_type(uint32_t kind, size_t region) {
  if (kind == NARSIL_MERGE_NUMERIC && region == 0) { return napi_float64_array; }
  if (kind == NARSIL_MERGE_ENUM && region == 0) { return napi_uint16_array; }
  if (kind == NARSIL_MERGE_GEO) {
    if (region == 0) { return napi_biguint64_array; }
    if (region == 1 || region == 2) { return napi_float64_array; }
  }
  if (kind == NARSIL_MERGE_STORED) {
    if (region == 0 || region == 2 || region == STORED_BYTES_REGION) { return napi_uint8_array; }
    if (region == 3) { return napi_float64_array; }
    if (region == STORED_UNITS_REGION) { return napi_uint16_array; }
  }
  return napi_uint32_array;
}

static int array_length(napi_env env, napi_value value, uint32_t *count) {
  bool array = false;
  return napi_is_array(env, value, &array) == napi_ok && array && napi_get_array_length(env, value, count) == napi_ok;
}

static int prepare_regions(napi_env env, napi_value array, size_t count, napi_value *handles) {
  uint32_t length = 0;
  if (!array_length(env, array, &length) || length != count) { return 0; }
  for (uint32_t at = 0; at < length; at++) {
    if (napi_get_element(env, array, at, handles + at) != napi_ok) { return 0; }
  }
  return 1;
}

static int prepare_sources(napi_env env, uint32_t kind, napi_value array, size_t count,
                           field_handles_for_merge *handles) {
  for (uint32_t at = 0; at < count; at++) {
    napi_value source = NULL;
    napi_value regions = NULL;
    if (napi_get_element(env, array, at, &source) != napi_ok ||
        napi_get_named_property(env, source, "mapping", &handles[at].mapping) != napi_ok ||
        napi_get_named_property(env, source, "regions", &regions) != napi_ok ||
        !prepare_regions(env, regions, region_count(kind), handles[at].regions)) {
      return 0;
    }
  }
  return 1;
}

static int read_sources(napi_env env, uint32_t kind, const field_handles_for_merge *handles,
                        narsil_field_merge_source *sources, size_t count) {
  for (size_t at = 0; at < count; at++) {
    void *mapping = NULL;
    if (!possibly_empty_typed_data(env, handles[at].mapping, napi_uint32_array, &mapping,
                                   &sources[at].document_count)) {
      return 0;
    }
    sources[at].mapping = mapping;
    for (size_t region = 0; region < region_count(kind); region++) {
      void *data = NULL;
      if (!possibly_empty_typed_data(env, handles[at].regions[region], region_type(kind, region), &data,
                                     &sources[at].regions[region].length)) {
        return 0;
      }
      sources[at].regions[region].data = data;
    }
  }
  return 1;
}

static narsil_status apply(napi_env env, thread_state *thread, const napi_value *argv, uint32_t kind,
                           uint32_t documents, uint32_t count, field_handles_for_merge *handles,
                           narsil_field_merge_source *sources, int writing) {
  napi_value output_handles[NARSIL_FIELD_MERGE_REGIONS] = {0};
  if (!prepare_sources(env, kind, argv[SOURCES], count, handles) ||
      (writing && !prepare_regions(env, argv[OUTPUT], region_count(kind), output_handles)) ||
      !read_sources(env, kind, handles, sources, count)) {
    return NARSIL_INVALID_ARGUMENT;
  }
  narsil_field_merge_request request = {kind, documents, sources, count};
  if (writing) {
    narsil_field_merge_output output = {0};
    for (size_t at = 0; at < region_count(kind); at++) {
      if (!possibly_empty_typed_data(env, output_handles[at], region_type(kind, at), &output.regions[at].data,
                                     &output.regions[at].capacity)) {
        return NARSIL_INVALID_ARGUMENT;
      }
    }
    return narsil_write_field_merge(thread->workspace, &request, &output);
  }
  void *sizes = NULL;
  size_t length = 0;
  if (!possibly_empty_typed_data(env, argv[OUTPUT], napi_uint32_array, &sizes, &length) ||
      length != NARSIL_FIELD_MERGE_REGIONS) {
    return NARSIL_INVALID_ARGUMENT;
  }
  _Static_assert(sizeof(narsil_field_merge_sizes) == NARSIL_FIELD_MERGE_REGIONS * sizeof(uint32_t), "field sizes");
  return narsil_measure_field_merge(thread->workspace, &request, sizes);
}

static napi_value merge(napi_env env, napi_callback_info info, int writing) {
  napi_value argv[ARGUMENTS];
  thread_state *thread = thread_state_of(env);
  uint32_t kind = 0;
  uint32_t documents = 0;
  uint32_t count = 0;
  if (thread == NULL || !callback_arguments(env, info, ARGUMENTS, argv) ||
      !segment_uint_argument(env, argv[KIND], &kind) || region_count(kind) == 0 ||
      !segment_uint_argument(env, argv[DOCUMENTS], &documents) || !array_length(env, argv[SOURCES], &count)) {
    return status_of(env, NARSIL_INVALID_ARGUMENT);
  }
  size_t source_count = count;
  if (source_count > SIZE_MAX / sizeof(field_handles_for_merge) ||
      source_count > SIZE_MAX / sizeof(narsil_field_merge_source)) {
    return status_of(env, NARSIL_OUT_OF_MEMORY);
  }
  field_handles_for_merge *handles = count == 0 ? NULL : calloc(count, sizeof *handles);
  narsil_field_merge_source *sources = count == 0 ? NULL : calloc(count, sizeof *sources);
  narsil_status status = NARSIL_OUT_OF_MEMORY;
  if (count == 0 || (handles != NULL && sources != NULL)) {
    status = apply(env, thread, argv, kind, documents, count, handles, sources, writing);
  }
  free(handles);
  free(sources);
  report_workspace_memory(env, thread);
  return status_of(env, status);
}

static napi_value measure(napi_env env, napi_callback_info info) { return merge(env, info, 0); }
static napi_value write(napi_env env, napi_callback_info info) { return merge(env, info, 1); }

int define_field_merges(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"measureFieldMerge", NULL, measure, NULL, NULL, NULL, napi_default_method, NULL},
      {"writeFieldMerge", NULL, write, NULL, NULL, NULL, napi_default_method, NULL},
  };
  return napi_define_properties(env, exports, sizeof properties / sizeof properties[0], properties) == napi_ok;
}
