#include "paged_vectors.h"

#include "../include/narsil_paged_vectors.h"
#include "paged.h"
#include "values.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

int read_paged_field(napi_env env, paged_field_handles *handles) {
  for (size_t at = 0; at < handles->field.file_count; at++) {
    vector_file_handles *file = &handles->file_handles[at];
    narsil_paged_vector_file *target = &handles->files[at];
    void *dead = NULL;
    if ((file->has_dead &&
         !possibly_empty_typed_data(env, file->values[FILE_DEAD], napi_uint8_array, &dead, &target->dead_bytes)) ||
        (file->has_dead && target->dead_bytes == 0) || !read_page_handles(env, &file->vectors, &target->vectors) ||
        (file->has_records && !read_page_handles(env, &file->records, &file->record_section))) {
      return 0;
    }
    target->dead = dead;
    target->records = file->has_records ? &file->record_section : NULL;
  }
  for (size_t at = 0; at < handles->field.part_count; at++) {
    graph_part_handles *part = &handles->part_handles[at];
    narsil_paged_graph_part *target = &handles->parts[at];
    void *levels = NULL;
    void *offsets = NULL;
    if (!possibly_empty_typed_data(env, part->values[PART_LEVELS], napi_uint8_array, &levels, &target->level_count) ||
        !possibly_empty_typed_data(env, part->values[PART_OFFSETS], napi_uint32_array, &offsets,
                                   &target->offset_count) ||
        !read_page_handles(env, &part->neighbours, &target->neighbours)) {
      return 0;
    }
    target->levels = levels;
    target->node_offsets = offsets;
  }
  if (handles->field.bits != 0) {
    void *centroid = NULL;
    if (!possibly_empty_typed_data(env, handles->centroid, napi_float32_array, &centroid,
                                   &handles->field.centroid_count)) {
      return 0;
    }
    handles->field.centroid = centroid;
  }
  return 1;
}

int prepare_paged_query(napi_env env, napi_value value, paged_query_handles *handles) {
  static const char *const keys[] = {"query",         "k",        "ef",      "rescoreDepth", "explicitRescoreWindow",
                                     "minSimilarity", "accepted", "excluded"};
  bool explicit_window = false;
  if (!paged_properties(env, value, keys, handles->values, QUERY_PROPERTIES) ||
      !paged_uint32(env, handles->values[QUERY_K], &handles->request.k) ||
      !paged_uint32(env, handles->values[QUERY_EF], &handles->request.ef) ||
      !paged_uint32(env, handles->values[QUERY_DEPTH], &handles->request.rescore_depth) ||
      napi_get_value_bool(env, handles->values[QUERY_EXPLICIT], &explicit_window) != napi_ok ||
      napi_get_value_double(env, handles->values[QUERY_FLOOR], &handles->request.min_similarity) != napi_ok ||
      !paged_nullable(env, handles->values[QUERY_ACCEPTED], &handles->accepted) ||
      !paged_nullable(env, handles->values[QUERY_EXCLUDED], &handles->excluded)) {
    return 0;
  }
  handles->request.explicit_rescore_window = (int)explicit_window;
  return 1;
}

int read_paged_query(napi_env env, paged_query_handles *handles) {
  void *query = NULL;
  void *accepted = NULL;
  void *excluded = NULL;
  if (!possibly_empty_typed_data(env, handles->values[QUERY_VECTOR], napi_float32_array, &query,
                                 &handles->request.query_count) ||
      (handles->accepted && !typed_data(env, handles->values[QUERY_ACCEPTED], napi_uint32_array, &accepted,
                                        &handles->request.accepted_words)) ||
      (handles->excluded && !typed_data(env, handles->values[QUERY_EXCLUDED], napi_uint32_array, &excluded,
                                        &handles->request.excluded_words))) {
    return 0;
  }
  handles->request.query = query;
  handles->request.accepted = accepted;
  handles->request.excluded = excluded;
  return 1;
}
