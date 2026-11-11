#include "paged_vectors.h"

#include "../include/narsil_core.h"
#include "paged.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <math.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

int paged_uint32(napi_env env, napi_value value, uint32_t *number) {
  double parsed = 0;
  if (napi_get_value_double(env, value, &parsed) != napi_ok || !isfinite(parsed) || parsed < 0 || parsed > UINT32_MAX ||
      floor(parsed) != parsed) {
    return 0;
  }
  *number = (uint32_t)parsed;
  return 1;
}

int paged_nullable(napi_env env, napi_value value, int *present) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok) { return 0; }
  *present = type != napi_null;
  return 1;
}

int paged_properties(napi_env env, napi_value object, const char *const *keys, napi_value *values, size_t count) {
  for (size_t at = 0; at < count; at++) {
    if (napi_get_named_property(env, object, keys[at], &values[at]) != napi_ok) { return 0; }
  }
  return 1;
}

void release_paged_field(paged_field_handles *handles) {
  free(handles->file_handles);
  free(handles->part_handles);
  free(handles->files);
  free(handles->parts);
}

static narsil_status allocate_lists(napi_env env, paged_field_handles *handles) {
  bool files_array = false;
  bool parts_array = false;
  uint32_t file_count = 0;
  uint32_t part_count = 0;
  if (napi_is_array(env, handles->values[FIELD_FILES], &files_array) != napi_ok || !files_array ||
      napi_is_array(env, handles->values[FIELD_PARTS], &parts_array) != napi_ok || !parts_array ||
      napi_get_array_length(env, handles->values[FIELD_FILES], &file_count) != napi_ok ||
      napi_get_array_length(env, handles->values[FIELD_PARTS], &part_count) != napi_ok) {
    return NARSIL_INVALID_ARGUMENT;
  }
  handles->field.file_count = file_count;
  handles->field.part_count = part_count;
  size_t files = file_count;
  size_t parts = part_count;
  if (files > SIZE_MAX / sizeof *handles->file_handles || files > SIZE_MAX / sizeof *handles->files ||
      parts > SIZE_MAX / sizeof *handles->part_handles || parts > SIZE_MAX / sizeof *handles->parts) {
    return NARSIL_OUT_OF_MEMORY;
  }
  if (file_count > 0) {
    handles->file_handles = calloc(file_count, sizeof *handles->file_handles);
    handles->files = calloc(file_count, sizeof *handles->files);
    if (handles->file_handles == NULL || handles->files == NULL) { return NARSIL_OUT_OF_MEMORY; }
  }
  if (part_count > 0) {
    handles->part_handles = calloc(part_count, sizeof *handles->part_handles);
    handles->parts = calloc(part_count, sizeof *handles->parts);
    if (handles->part_handles == NULL || handles->parts == NULL) { return NARSIL_OUT_OF_MEMORY; }
  }
  handles->field.files = handles->files;
  handles->field.parts = handles->parts;
  return NARSIL_OK;
}

static int prepare_files(napi_env env, paged_field_handles *handles) {
  static const char *const keys[] = {"first", "count", "dead", "vectors", "records"};
  for (uint32_t at = 0; at < handles->field.file_count; at++) {
    napi_value value;
    vector_file_handles *file = &handles->file_handles[at];
    if (napi_get_element(env, handles->values[FIELD_FILES], at, &value) != napi_ok ||
        !paged_properties(env, value, keys, file->values, FILE_PROPERTIES) ||
        !paged_uint32(env, file->values[FILE_FIRST], &handles->files[at].first) ||
        !paged_uint32(env, file->values[FILE_COUNT], &handles->files[at].count) ||
        !paged_nullable(env, file->values[FILE_DEAD], &file->has_dead) ||
        !paged_nullable(env, file->values[FILE_RECORDS], &file->has_records) ||
        !prepare_page_handles(env, file->values[FILE_VECTORS], &file->vectors) ||
        (file->has_records && !prepare_page_handles(env, file->values[FILE_RECORDS], &file->records))) {
      return 0;
    }
  }
  return 1;
}

static int prepare_parts(napi_env env, paged_field_handles *handles) {
  static const char *const keys[] = {"first", "count", "levels", "nodeOffsets", "neighbours"};
  for (uint32_t at = 0; at < handles->field.part_count; at++) {
    napi_value value;
    graph_part_handles *part = &handles->part_handles[at];
    if (napi_get_element(env, handles->values[FIELD_PARTS], at, &value) != napi_ok ||
        !paged_properties(env, value, keys, part->values, PART_PROPERTIES) ||
        !paged_uint32(env, part->values[PART_FIRST], &handles->parts[at].first) ||
        !paged_uint32(env, part->values[PART_COUNT], &handles->parts[at].count) ||
        !prepare_page_handles(env, part->values[PART_NEIGHBOURS], &part->neighbours)) {
      return 0;
    }
  }
  return 1;
}

narsil_status prepare_paged_field(napi_env env, napi_value value, paged_field_handles *handles) {
  static const char *const keys[] = {"dimension", "metric", "total", "entryPoint",
                                     "maxLayer",  "codes",  "files", "graphParts"};
  int codes = 0;
  if (!paged_properties(env, value, keys, handles->values, FIELD_PROPERTIES) ||
      !paged_uint32(env, handles->values[FIELD_DIMENSION], &handles->field.dimension) ||
      !paged_uint32(env, handles->values[FIELD_METRIC], &handles->field.metric) ||
      !paged_uint32(env, handles->values[FIELD_TOTAL], &handles->field.total) ||
      !paged_uint32(env, handles->values[FIELD_LAYER], &handles->field.max_layer) ||
      !paged_nullable(env, handles->values[FIELD_ENTRY], &handles->field.has_entry_point) ||
      (handles->field.has_entry_point &&
       !paged_uint32(env, handles->values[FIELD_ENTRY], &handles->field.entry_point)) ||
      !paged_nullable(env, handles->values[FIELD_CODES], &codes)) {
    return NARSIL_INVALID_ARGUMENT;
  }
  if (codes) {
    napi_value bits;
    if (napi_get_named_property(env, handles->values[FIELD_CODES], "bits", &bits) != napi_ok ||
        napi_get_named_property(env, handles->values[FIELD_CODES], "centroid", &handles->centroid) != napi_ok ||
        !paged_uint32(env, bits, &handles->field.bits) || handles->field.bits == 0) {
      return NARSIL_INVALID_ARGUMENT;
    }
  }
  narsil_status status = allocate_lists(env, handles);
  if (status != NARSIL_OK) { return status; }
  return prepare_files(env, handles) && prepare_parts(env, handles) ? NARSIL_OK : NARSIL_INVALID_ARGUMENT;
}
