#include "segment_merge.h"

#include "../include/narsil_segment_merge.h"
#include "segments.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <stddef.h>
#include <stdint.h>

static int strings(napi_env env, const napi_value *handles, narsil_merged_strings *table) {
  const napi_typedarray_type types[MERGE_STRING_HANDLES] = {napi_uint8_array, napi_uint32_array, napi_uint32_array};
  void *data[MERGE_STRING_HANDLES] = {0};
  size_t lengths[MERGE_STRING_HANDLES] = {0};
  if (!read_segment_arrays(env, handles, types, MERGE_STRING_HANDLES, data, lengths)) { return 0; }
  *table = (narsil_merged_strings){data[0], data[1], data[2], lengths[2], lengths[0], lengths[1]};
  return 1;
}

int read_merge_output(napi_env env, const merge_output_handles *handles, narsil_keyword_merge_output *output) {
  enum { OFFSETS, DOCUMENTS, FREQUENCIES, FIELDS, POSITION_OFFSETS, POSITIONS, LENGTHS, TOTALS };
  const napi_typedarray_type types[MERGE_OUTPUT_HANDLES] = {napi_uint32_array, napi_uint32_array, napi_uint16_array,
                                                            napi_uint16_array, napi_uint32_array, napi_uint32_array,
                                                            napi_uint32_array, napi_float64_array};
  void *data[MERGE_OUTPUT_HANDLES] = {0};
  size_t lengths[MERGE_OUTPUT_HANDLES] = {0};
  napi_valuetype positions_type = napi_undefined;
  napi_valuetype values_type = napi_undefined;
  if (!strings(env, handles->terms, &output->terms) || !strings(env, handles->surfaces, &output->surfaces) ||
      !strings(env, handles->spellings, &output->spellings) ||
      !merge_read_arrays(env, handles->arrays, types, MERGE_OUTPUT_HANDLES, data, lengths,
                         (UINT32_C(1) << POSITION_OFFSETS) | (UINT32_C(1) << POSITIONS)) ||
      lengths[FREQUENCIES] != lengths[DOCUMENTS] || lengths[FIELDS] != lengths[DOCUMENTS] ||
      napi_typeof(env, handles->arrays[POSITION_OFFSETS], &positions_type) != napi_ok ||
      napi_typeof(env, handles->arrays[POSITIONS], &values_type) != napi_ok ||
      (positions_type == napi_null) != (values_type == napi_null)) {
    return 0;
  }
  output->posting_offsets = data[OFFSETS];
  output->posting_offset_capacity = lengths[OFFSETS];
  output->posting_documents = data[DOCUMENTS];
  output->posting_frequencies = data[FREQUENCIES];
  output->posting_fields = data[FIELDS];
  output->posting_capacity = lengths[DOCUMENTS];
  output->position_offsets = data[POSITION_OFFSETS];
  output->position_offset_capacity = lengths[POSITION_OFFSETS];
  output->position_values = data[POSITIONS];
  output->position_capacity = lengths[POSITIONS];
  output->field_lengths = data[LENGTHS];
  output->field_length_capacity = lengths[LENGTHS];
  output->total_field_lengths = data[TOTALS];
  output->field_count = lengths[TOTALS];
  return 1;
}
