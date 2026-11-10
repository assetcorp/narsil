#include "segment_merge.h"

#include "../include/narsil_frozen_segments.h"
#include "../include/narsil_segment_merge.h"
#include "segments.h"
#include "values.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

int merge_read_arrays(napi_env env, const napi_value *handles, const napi_typedarray_type *types, size_t count,
                      void **data, size_t *lengths, uint32_t nullable) {
  for (size_t at = 0; at < count; at++) {
    napi_valuetype type = napi_undefined;
    if (napi_typeof(env, handles[at], &type) != napi_ok) { return 0; }
    if (type == napi_null && (nullable & (UINT32_C(1) << at)) != 0) { continue; }
    if (!possibly_empty_typed_data(env, handles[at], types[at], data + at, lengths + at)) { return 0; }
  }
  return 1;
}

int read_merge_strings(napi_env env, const napi_value *handles, size_t stride, narsil_frozen_strings *table) {
  const napi_typedarray_type types[MERGE_STRING_HANDLES] = {napi_uint8_array, napi_uint32_array, napi_uint32_array};
  void *data[MERGE_STRING_HANDLES] = {0};
  size_t lengths[MERGE_STRING_HANDLES] = {0};
  if (!read_segment_arrays(env, handles, types, MERGE_STRING_HANDLES, data, lengths) || lengths[0] > UINT32_MAX ||
      lengths[2] > UINT32_MAX || lengths[2] > (SIZE_MAX - 1) / stride || lengths[1] != (lengths[2] * stride) + 1) {
    return 0;
  }
  *table = (narsil_frozen_strings){data[0], lengths[0], data[1], data[2], lengths[2]};
  return 1;
}

static int field_lengths(napi_env env, const merge_input_handles *handles, merge_input_storage *storage) {
  if (handles->field_count == 0) { return 1; }
  storage->lengths = (const uint32_t **)calloc(handles->field_count, sizeof *storage->lengths);
  if (storage->lengths == NULL) {
    storage->out_of_memory = 1;
    return 0;
  }
  for (size_t at = 0; at < handles->field_count; at++) {
    napi_valuetype type = napi_undefined;
    void *data = NULL;
    size_t length = 0;
    if (napi_typeof(env, handles->lengths[at], &type) != napi_ok) { return 0; }
    if (type == napi_null) { continue; }
    if (!possibly_empty_typed_data(env, handles->lengths[at], napi_uint32_array, &data, &length) ||
        length != handles->document_count) {
      return 0;
    }
    storage->lengths[at] = data;
  }
  return 1;
}

int read_merge_input(napi_env env, const merge_input_handles *handles, narsil_keyword_merge_input *input,
                     merge_input_storage *storage) {
  enum { SLOTS, OFFSETS, DOCUMENTS, FREQUENCIES, FIELDS, POSITION_OFFSETS, POSITIONS, MAPPING, FIELD_MAPPING };
  const napi_typedarray_type types[MERGE_INPUT_HANDLES] = {napi_uint32_array, napi_uint32_array, napi_uint32_array,
                                                           napi_uint16_array, napi_uint16_array, napi_uint32_array,
                                                           napi_uint32_array, napi_uint32_array, napi_uint16_array};
  void *data[MERGE_INPUT_HANDLES] = {0};
  size_t lengths[MERGE_INPUT_HANDLES] = {0};
  if ((!handles->has_growing && !read_merge_strings(env, handles->terms, 1, &input->terms)) ||
      (handles->has_growing && !read_segment(env, &handles->growing, &storage->growing)) ||
      (handles->has_surfaces && !read_merge_strings(env, handles->surfaces, 2, &storage->surfaces)) ||
      (handles->has_spellings && !read_merge_strings(env, handles->spellings, 2, &storage->spellings)) ||
      !merge_read_arrays(env, handles->arrays, types, MERGE_INPUT_HANDLES, data, lengths,
                         (UINT32_C(1) << POSITION_OFFSETS) | (UINT32_C(1) << POSITIONS)) ||
      input->terms.count == SIZE_MAX ||
      (!handles->has_growing && (lengths[SLOTS] != input->terms.count || lengths[OFFSETS] != input->terms.count + 1)) ||
      lengths[DOCUMENTS] > UINT32_MAX || lengths[DOCUMENTS] == SIZE_MAX || lengths[FREQUENCIES] != lengths[DOCUMENTS] ||
      lengths[FIELDS] != lengths[DOCUMENTS] || lengths[MAPPING] != handles->document_count ||
      lengths[FIELD_MAPPING] != handles->field_count || !field_lengths(env, handles, storage)) {
    return 0;
  }
  napi_valuetype positions_type = napi_undefined;
  napi_valuetype values_type = napi_undefined;
  if (napi_typeof(env, handles->arrays[POSITION_OFFSETS], &positions_type) != napi_ok ||
      napi_typeof(env, handles->arrays[POSITIONS], &values_type) != napi_ok ||
      (positions_type == napi_null) != (values_type == napi_null) ||
      (positions_type != napi_null && lengths[POSITION_OFFSETS] != lengths[DOCUMENTS] + 1)) {
    return 0;
  }
  input->payload_slots = data[SLOTS];
  input->posting_offsets = data[OFFSETS];
  input->posting_documents = data[DOCUMENTS];
  input->posting_frequencies = data[FREQUENCIES];
  input->posting_fields = data[FIELDS];
  input->posting_count = lengths[DOCUMENTS];
  input->position_offsets = data[POSITION_OFFSETS];
  input->position_values = data[POSITIONS];
  input->position_count = lengths[POSITIONS];
  input->mapping = data[MAPPING];
  input->field_mapping = data[FIELD_MAPPING];
  input->field_lengths = storage->lengths;
  input->field_count = handles->field_count;
  input->document_count = handles->document_count;
  input->surfaces = handles->has_surfaces ? &storage->surfaces : NULL;
  input->spellings = handles->has_spellings ? &storage->spellings : NULL;
  input->growing = handles->has_growing ? &storage->growing.growing : NULL;
  return 1;
}
