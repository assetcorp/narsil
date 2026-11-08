#include "segments.h"

#include "../include/narsil_segments.h"
#include "terms.h"
#include "values.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <stddef.h>
#include <stdint.h>

int read_segment_arrays(napi_env env, const napi_value *handles, const napi_typedarray_type *types, size_t count,
                        void **data, size_t *lengths) {
  for (size_t index = 0; index < count; index++) {
    if (!possibly_empty_typed_data(env, handles[index], types[index], &data[index], &lengths[index])) { return 0; }
  }
  return 1;
}

static int read_columns(napi_env env, const segment_handles *handles, narsil_term_columns *columns) {
  enum { START, CLASS, LENGTH, FREQUENCY, DEAD, TOTAL, SURFACES, REVISION, FLAGS };
  const napi_typedarray_type types[SEGMENT_COLUMN_HANDLES] = {
      napi_uint32_array,  napi_uint8_array,   napi_uint32_array, napi_uint32_array, napi_uint32_array,
      napi_float64_array, napi_float64_array, napi_uint32_array, napi_uint8_array,
  };
  void *data[SEGMENT_COLUMN_HANDLES] = {0};
  size_t lengths[SEGMENT_COLUMN_HANDLES] = {0};
  if (!read_segment_arrays(env, handles->columns, types, SEGMENT_COLUMN_HANDLES, data, lengths)) { return 0; }
  for (size_t index = 1; index < SEGMENT_COLUMN_HANDLES; index++) {
    if (lengths[index] != lengths[START]) { return 0; }
  }
  *columns = (narsil_term_columns){data[START], data[CLASS],    data[LENGTH],   data[FREQUENCY], data[DEAD],
                                   data[TOTAL], data[SURFACES], data[REVISION], data[FLAGS],     lengths[START]};
  return 1;
}

static int read_postings(napi_env env, const segment_handles *handles, narsil_posting_pool *postings) {
  enum { DOCS, COUNTS, FIELDS, POSITIONS, ALLOCATION, HEADS, SIZES };
  const napi_typedarray_type types[SEGMENT_POSTING_HANDLES] = {
      napi_uint32_array, napi_uint16_array, napi_uint16_array, napi_uint32_array,
      napi_uint32_array, napi_uint32_array, napi_uint32_array,
  };
  void *data[SEGMENT_POSTING_HANDLES] = {0};
  size_t lengths[SEGMENT_POSTING_HANDLES] = {0};
  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, handles->postings[POSITIONS], &type) != napi_ok) { return 0; }
  for (size_t index = 0; index < SEGMENT_POSTING_HANDLES; index++) {
    if (index == POSITIONS && type == napi_null) { continue; }
    if (!possibly_empty_typed_data(env, handles->postings[index], types[index], &data[index], &lengths[index])) {
      return 0;
    }
  }
  if (lengths[COUNTS] != lengths[DOCS] || lengths[FIELDS] != lengths[DOCS] ||
      (type != napi_null && lengths[POSITIONS] != lengths[DOCS]) || lengths[ALLOCATION] != 2 ||
      lengths[HEADS] != lengths[SIZES]) {
    return 0;
  }
  *postings = (narsil_posting_pool){data[DOCS],    data[COUNTS],
                                    data[FIELDS],  data[POSITIONS],
                                    lengths[DOCS], {data[ALLOCATION], data[HEADS], data[SIZES], lengths[SIZES]}};
  return 1;
}

static int read_values(napi_env env, const segment_handles *handles, narsil_growing_segment *segment) {
  enum { RETIRED, LENGTHS, DOCUMENTS, TOTAL, PARTIAL };
  enum { BITS_PER_WORD = 32 };
  const napi_typedarray_type types[SEGMENT_VALUE_HANDLES] = {
      napi_uint32_array, napi_uint32_array, napi_uint32_array, napi_float64_array, napi_uint8_array,
  };
  void *data[SEGMENT_VALUE_HANDLES] = {0};
  size_t lengths[SEGMENT_VALUE_HANDLES] = {0};
  if (!read_segment_arrays(env, handles->values, types, SEGMENT_VALUE_HANDLES, data, lengths)) { return 0; }
  size_t fields = lengths[PARTIAL];
  uint32_t capacity = handles->ordinal_capacity;
  size_t words = capacity == 0 ? 1 : (((size_t)capacity - 1) / BITS_PER_WORD) + 1;
  if (fields > (size_t)UINT16_MAX + 1 || (fields > 0 && capacity > SIZE_MAX / fields) ||
      lengths[LENGTHS] != fields * capacity || lengths[RETIRED] != words || lengths[DOCUMENTS] != 1 ||
      lengths[TOTAL] != fields) {
    return 0;
  }
  segment->retired = data[RETIRED];
  segment->field_lengths = data[LENGTHS];
  segment->total_documents = data[DOCUMENTS];
  segment->total_field_lengths = data[TOTAL];
  segment->partial_fields = data[PARTIAL];
  segment->ordinal_capacity = capacity;
  segment->field_count = (uint32_t)fields;
  return 1;
}

int read_segment(napi_env env, const segment_handles *handles, node_segment *segment) {
  return read_term_table(env, handles->terms, &segment->growing.terms) &&
         read_columns(env, handles, &segment->growing.columns) &&
         read_postings(env, handles, &segment->growing.postings) && read_values(env, handles, &segment->growing) &&
         read_segment_optional(env, handles, segment);
}
