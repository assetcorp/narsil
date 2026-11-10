#include "frozen_segments.h"

#include "../include/narsil_frozen_segments.h"
#include "segments.h"

#include <js_native_api_types.h>
#include <stddef.h>
#include <stdint.h>

static int strings(napi_env env, const napi_value *handles, size_t stride, narsil_frozen_strings *table) {
  enum { TEXT, OFFSETS, COUNTS };
  const napi_typedarray_type types[FROZEN_STRING_HANDLES] = {napi_uint8_array, napi_uint32_array, napi_uint32_array};
  void *data[FROZEN_STRING_HANDLES] = {0};
  size_t lengths[FROZEN_STRING_HANDLES] = {0};
  if (!read_segment_arrays(env, handles, types, FROZEN_STRING_HANDLES, data, lengths) || lengths[TEXT] > UINT32_MAX ||
      lengths[COUNTS] > UINT32_MAX || lengths[COUNTS] > (SIZE_MAX - 1) / stride ||
      lengths[OFFSETS] != (lengths[COUNTS] * stride) + 1) {
    return 0;
  }
  *table = (narsil_frozen_strings){data[TEXT], lengths[TEXT], data[OFFSETS], data[COUNTS], lengths[COUNTS]};
  return 1;
}

static int postings(napi_env env, const frozen_handles *handles, narsil_frozen_segment *segment) {
  enum { SLOTS, OFFSETS, DOCUMENTS, FREQUENCIES, FIELDS, PARTIAL, SPELLING_TOKENS };
  const napi_typedarray_type types[FROZEN_POSTING_HANDLES] = {napi_uint32_array, napi_uint32_array, napi_uint32_array,
                                                              napi_uint16_array, napi_uint16_array, napi_uint8_array,
                                                              napi_uint32_array};
  void *data[FROZEN_POSTING_HANDLES] = {0};
  size_t lengths[FROZEN_POSTING_HANDLES] = {0};
  size_t spelling_count = segment->spellings == NULL ? 0 : segment->spellings->count;
  if (!read_segment_arrays(env, handles->postings, types, FROZEN_POSTING_HANDLES, data, lengths) ||
      segment->terms.count == SIZE_MAX || lengths[SLOTS] != segment->terms.count ||
      lengths[OFFSETS] != segment->terms.count + 1 || lengths[DOCUMENTS] > UINT32_MAX ||
      lengths[FREQUENCIES] != lengths[DOCUMENTS] || lengths[FIELDS] != lengths[DOCUMENTS] ||
      lengths[PARTIAL] > (size_t)UINT16_MAX + 1 || lengths[SPELLING_TOKENS] != spelling_count) {
    return 0;
  }
  segment->payload_slots = data[SLOTS];
  segment->posting_offsets = data[OFFSETS];
  segment->posting_documents = data[DOCUMENTS];
  segment->posting_frequencies = data[FREQUENCIES];
  segment->posting_fields = data[FIELDS];
  segment->posting_count = lengths[DOCUMENTS];
  segment->partial_fields = data[PARTIAL];
  segment->field_count = (uint32_t)lengths[PARTIAL];
  segment->spelling_tokens = data[SPELLING_TOKENS];
  segment->document_count = handles->document_count;
  return 1;
}

static int read_state(napi_env env, const frozen_handles *handles, node_frozen_segment *segment) {
  enum { BITS, COUNT, DOCUMENTS, OCCURRENCES, SURFACES, SPELLINGS, HEADER, PENDING, TOKENS, UNITS };
  enum { WORD_BITS = 32 };
  const napi_typedarray_type types[FROZEN_STATE_HANDLES] = {
      napi_uint32_array, napi_uint32_array, napi_uint32_array, napi_float64_array, napi_uint32_array,
      napi_uint32_array, napi_uint32_array, napi_uint32_array, napi_uint32_array,  napi_uint16_array};
  void *data[FROZEN_STATE_HANDLES] = {0};
  size_t lengths[FROZEN_STATE_HANDLES] = {0};
  size_t capacity = handles->document_count;
  size_t words = capacity == 0 ? 1 : ((capacity - 1) / WORD_BITS) + 1;
  if (!read_segment_arrays(env, handles->state, types, FROZEN_STATE_HANDLES, data, lengths) || lengths[BITS] != words ||
      lengths[COUNT] != 1 || lengths[DOCUMENTS] != segment->segment.terms.count ||
      lengths[OCCURRENCES] != lengths[DOCUMENTS] || lengths[SURFACES] != segment->surfaces.count ||
      lengths[SPELLINGS] != segment->spellings.count || lengths[HEADER] != NARSIL_PENDING_HEADER_WORDS ||
      lengths[TOKENS] % NARSIL_PENDING_TOKEN_WORDS != 0) {
    return 0;
  }
  segment->state = (narsil_frozen_segment_state){
      .tombstones = data[BITS],
      .tombstone_count = data[COUNT],
      .removed_documents = data[DOCUMENTS],
      .removed_occurrences = data[OCCURRENCES],
      .removed_surfaces = data[SURFACES],
      .removed_spellings = data[SPELLINGS],
      .pending_header = data[HEADER],
      .pending_documents = data[PENDING],
      .pending_document_capacity = lengths[PENDING],
      .pending_tokens = data[TOKENS],
      .pending_token_capacity = lengths[TOKENS] / NARSIL_PENDING_TOKEN_WORDS,
      .pending_units = data[UNITS],
      .pending_unit_capacity = lengths[UNITS],
  };
  return 1;
}

static int read_index(napi_env env, const frozen_handles *handles, node_frozen_segment *segment) {
  if (!handles->has_index) { return 1; }
  enum { STARTS, ROWS, TERMS };
  const napi_typedarray_type types[FROZEN_INDEX_HANDLES] = {napi_uint32_array, napi_uint32_array, napi_uint32_array};
  void *data[FROZEN_INDEX_HANDLES] = {0};
  size_t lengths[FROZEN_INDEX_HANDLES] = {0};
  size_t starts = (size_t)handles->document_count + 1;
  if (starts == 0 || !read_segment_arrays(env, handles->index, types, FROZEN_INDEX_HANDLES, data, lengths) ||
      lengths[STARTS] != starts || lengths[ROWS] != segment->segment.posting_count ||
      lengths[TERMS] != segment->segment.terms.count) {
    return 0;
  }
  segment->index = (narsil_frozen_removal_index){data[STARTS], data[ROWS], data[TERMS]};
  segment->segment.removal_index = &segment->index;
  return 1;
}

int read_frozen_segment(napi_env env, const frozen_handles *handles, node_frozen_segment *segment) {
  if (!strings(env, handles->terms, 1, &segment->segment.terms) ||
      (handles->has_surfaces && !strings(env, handles->surfaces, 2, &segment->surfaces)) ||
      (handles->has_spellings && !strings(env, handles->spellings, 1, &segment->spellings))) {
    return 0;
  }
  segment->segment.surfaces = handles->has_surfaces ? &segment->surfaces : NULL;
  segment->segment.spellings = handles->has_spellings ? &segment->spellings : NULL;
  return postings(env, handles, &segment->segment) && read_state(env, handles, segment) &&
         read_index(env, handles, segment);
}
