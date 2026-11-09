#include "frozen_segments.h"

#include "../include/narsil_core.h"
#include "../include/narsil_frozen_segments.h"
#include "../include/narsil_segments.h"
#include "paged.h"
#include "segments.h"
#include "values.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

static const char *const STRING_PROPERTIES[FROZEN_STRING_HANDLES] = {"text", "offsets", "counts"};
static const char *const POSTING_PROPERTIES[FROZEN_POSTING_HANDLES] = {
    "payloadSlots",  "postingOffsets", "postingDocuments", "postingFrequencies",
    "postingFields", "partialFields",  "spellingTokens"};
static const char *const STATE_PROPERTIES[FROZEN_STATE_HANDLES] = {
    "tombstones",       "tombstoneCount", "removedDocuments", "removedOccurrences", "removedSurfaces",
    "removedSpellings", "pendingHeader",  "pendingDocuments", "pendingTokens",      "pendingUnits"};
static const char *const PAGED_PROPERTIES[] = {"offsets", "values", "cache", "fault"};
static const char *const INDEX_PROPERTIES[FROZEN_INDEX_HANDLES] = {"starts", "rows", "termOfSlot"};

static int properties(napi_env env, napi_value value, const char *const *keys, size_t count, napi_value *handles) {
  for (size_t at = 0; at < count; at++) {
    if (napi_get_named_property(env, value, keys[at], handles + at) != napi_ok) { return 0; }
  }
  return 1;
}

static int optional(napi_env env, napi_value source, const char *key, napi_value *value, int *present) {
  napi_valuetype type = napi_undefined;
  if (napi_get_named_property(env, source, key, value) != napi_ok || napi_typeof(env, *value, &type) != napi_ok ||
      (type != napi_null && type != napi_object)) {
    return 0;
  }
  *present = type == napi_object;
  return 1;
}

int prepare_frozen_segment(napi_env env, napi_value source, napi_value state, frozen_handles *handles) {
  napi_value terms = NULL;
  napi_value surfaces = NULL;
  napi_value spellings = NULL;
  napi_value index = NULL;
  napi_value count = NULL;
  return napi_get_named_property(env, source, "terms", &terms) == napi_ok &&
         properties(env, terms, STRING_PROPERTIES, FROZEN_STRING_HANDLES, handles->terms) &&
         properties(env, source, POSTING_PROPERTIES, FROZEN_POSTING_HANDLES, handles->postings) &&
         properties(env, state, STATE_PROPERTIES, FROZEN_STATE_HANDLES, handles->state) &&
         napi_get_named_property(env, source, "documentCount", &count) == napi_ok &&
         segment_uint_argument(env, count, &handles->document_count) &&
         optional(env, source, "surfaces", &surfaces, &handles->has_surfaces) &&
         optional(env, source, "spellings", &spellings, &handles->has_spellings) &&
         optional(env, source, "removalIndex", &index, &handles->has_index) &&
         (!handles->has_surfaces ||
          properties(env, surfaces, STRING_PROPERTIES, FROZEN_STRING_HANDLES, handles->surfaces)) &&
         (!handles->has_spellings ||
          properties(env, spellings, STRING_PROPERTIES, FROZEN_STRING_HANDLES, handles->spellings)) &&
         (!handles->has_index || properties(env, index, INDEX_PROPERTIES, FROZEN_INDEX_HANDLES, handles->index));
}

enum {
  REGION_DOCUMENT_COUNT = 0,
  REGION_TERMS = REGION_DOCUMENT_COUNT + 1,
  REGION_SURFACES = REGION_TERMS + FROZEN_STRING_HANDLES,
  REGION_SPELLINGS = REGION_SURFACES + FROZEN_STRING_HANDLES,
  REGION_POSTINGS = REGION_SPELLINGS + FROZEN_STRING_HANDLES,
  REGION_INDEX = REGION_POSTINGS + FROZEN_POSTING_HANDLES,
  REGION_STATE = REGION_INDEX + FROZEN_INDEX_HANDLES,
  FROZEN_REGION_ARGUMENTS = REGION_STATE + FROZEN_STATE_HANDLES
};

static void copy_handles(const napi_value *values, size_t count, napi_value *handles) {
  for (size_t at = 0; at < count; at++) { handles[at] = values[at]; }
}

static int optional_group(napi_env env, const napi_value *values, size_t count, napi_value *handles, int *present) {
  size_t absent = 0;
  for (size_t at = 0; at < count; at++) {
    napi_valuetype type = napi_undefined;
    if (napi_typeof(env, values[at], &type) != napi_ok) { return 0; }
    absent += type == napi_null ? 1 : 0;
    handles[at] = values[at];
  }
  *present = absent == 0;
  return absent == 0 || absent == count;
}

static int prepare_frozen_arguments(napi_env env, const napi_value *argv, frozen_handles *handles) {
  copy_handles(argv + REGION_TERMS, FROZEN_STRING_HANDLES, handles->terms);
  copy_handles(argv + REGION_POSTINGS, FROZEN_POSTING_HANDLES, handles->postings);
  copy_handles(argv + REGION_STATE, FROZEN_STATE_HANDLES, handles->state);
  return segment_uint_argument(env, argv[REGION_DOCUMENT_COUNT], &handles->document_count) &&
         optional_group(env, argv + REGION_SURFACES, FROZEN_STRING_HANDLES, handles->surfaces,
                        &handles->has_surfaces) &&
         optional_group(env, argv + REGION_SPELLINGS, FROZEN_STRING_HANDLES, handles->spellings,
                        &handles->has_spellings) &&
         optional_group(env, argv + REGION_INDEX, FROZEN_INDEX_HANDLES, handles->index, &handles->has_index);
}

int prepare_frozen_paged(napi_env env, napi_value value, frozen_paged_handles *handles) {
  enum { OFFSETS, VALUES, CACHE, FAULT, PAGED_HANDLES };
  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, value, &type) != napi_ok) { return 0; }
  handles->present = type != napi_null && type != napi_undefined;
  if (!handles->present) { return 1; }
  napi_value values[PAGED_HANDLES];
  if (type != napi_object || !properties(env, value, PAGED_PROPERTIES, PAGED_HANDLES, values)) { return 0; }
  handles->fault = values[FAULT];
  return prepare_page_handles(env, values[OFFSETS], &handles->offsets) &&
         prepare_page_handles(env, values[VALUES], &handles->values) &&
         prepare_page_cache_handles(env, values[CACHE], &handles->cache);
}

int read_frozen_paged(napi_env env, const frozen_paged_handles *handles, node_frozen_paged *paged,
                      const narsil_frozen_paged_removals **removals) {
  enum { FAULT_WORDS = 3 };
  *removals = NULL;
  if (!handles->present) { return 1; }
  void *fault = NULL;
  size_t fault_words = 0;
  if (!read_page_handles(env, &handles->offsets, &paged->offsets) ||
      !read_page_handles(env, &handles->values, &paged->values) ||
      !read_page_cache_handles(env, &handles->cache, &paged->cache) ||
      !typed_data(env, handles->fault, napi_biguint64_array, &fault, &fault_words) || fault_words != FAULT_WORDS) {
    return 0;
  }
  paged->removals = (narsil_frozen_paged_removals){handles->cache.present ? &paged->cache : NULL, &paged->offsets,
                                                   &paged->values, fault};
  *removals = &paged->removals;
  return 1;
}

enum { ORDINAL = FROZEN_REGION_ARGUMENTS, FIELDS, PAGED, REMOVE_ARGUMENTS };
enum { ENTRIES = PAGED, VALUES, PREPARED_PAGED, PREPARE_ARGUMENTS };
enum { STACK_FIELDS = 8 };

static narsil_status apply(napi_env env, thread_state *thread, const napi_value *argv, uint32_t count,
                           field_handles *handles, narsil_field_tokens *fields, int preparing, size_t *written) {
  frozen_handles source = {0};
  node_frozen_segment segment = {0};
  frozen_paged_handles paged_handles = {0};
  node_frozen_paged paged = {0};
  const narsil_frozen_paged_removals *removals = NULL;
  uint32_t ordinal = 0;
  if (!prepare_frozen_arguments(env, argv, &source) || !segment_uint_argument(env, argv[ORDINAL], &ordinal) ||
      !prepare_segment_fields(env, argv[FIELDS], handles, count) ||
      !prepare_frozen_paged(env, argv[preparing ? PREPARED_PAGED : PAGED], &paged_handles) ||
      !read_frozen_segment(env, &source, &segment) || !read_segment_fields(env, handles, fields, count) ||
      !read_frozen_paged(env, &paged_handles, &paged, &removals)) {
    return NARSIL_INVALID_ARGUMENT;
  }
  narsil_remove_frozen_request request = {&segment.segment, &segment.state, ordinal, fields, count, removals};
  if (preparing) {
    void *entries = NULL;
    void *values = NULL;
    size_t entry_words = 0;
    size_t value_capacity = 0;
    if (!possibly_empty_typed_data(env, argv[ENTRIES], napi_uint32_array, &entries, &entry_words) ||
        !possibly_empty_typed_data(env, argv[VALUES], napi_float64_array, &values, &value_capacity) ||
        entry_words % 2 != 0) {
      return NARSIL_INVALID_ARGUMENT;
    }
    narsil_frozen_removal_output output = {entries, values, entry_words / 2, value_capacity};
    return narsil_prepare_frozen_removal(thread->workspace, &request, &output, written);
  }
  return narsil_remove_frozen_document(thread->workspace, &request);
}

napi_value settle_frozen_state(napi_env env, napi_callback_info info) {
  enum { SETTLE_PAGED = FROZEN_REGION_ARGUMENTS, SETTLE_ARGUMENTS };
  napi_value argv[SETTLE_ARGUMENTS];
  thread_state *thread = thread_state_of(env);
  frozen_handles source = {0};
  node_frozen_segment segment = {0};
  frozen_paged_handles paged_handles = {0};
  node_frozen_paged paged = {0};
  const narsil_frozen_paged_removals *removals = NULL;
  if (thread == NULL || !callback_arguments(env, info, SETTLE_ARGUMENTS, argv) ||
      !prepare_frozen_arguments(env, argv, &source) || !prepare_frozen_paged(env, argv[SETTLE_PAGED], &paged_handles) ||
      !read_frozen_segment(env, &source, &segment) || !read_frozen_paged(env, &paged_handles, &paged, &removals)) {
    return status_of(env, NARSIL_INVALID_ARGUMENT);
  }
  narsil_status status = narsil_settle_frozen_state(thread->workspace, &segment.segment, &segment.state, removals);
  report_workspace_memory(env, thread);
  return status_of(env, status);
}

static napi_value mutate(napi_env env, napi_callback_info info, int preparing) {
  napi_value argv[PREPARE_ARGUMENTS];
  thread_state *thread = thread_state_of(env);
  uint32_t count = 0;
  bool array = false;
  if (thread == NULL || !callback_arguments(env, info, preparing ? PREPARE_ARGUMENTS : REMOVE_ARGUMENTS, argv) ||
      napi_is_array(env, argv[FIELDS], &array) != napi_ok || !array ||
      napi_get_array_length(env, argv[FIELDS], &count) != napi_ok || count > (uint32_t)UINT16_MAX + 1) {
    return number_of(env, preparing ? -NARSIL_INVALID_ARGUMENT : NARSIL_INVALID_ARGUMENT);
  }
  field_handles local_handles[STACK_FIELDS] = {0};
  narsil_field_tokens local_fields[STACK_FIELDS] = {0};
  field_handles *handles = local_handles;
  narsil_field_tokens *fields = local_fields;
  if (count > STACK_FIELDS) {
    handles = calloc(count, sizeof *handles);
    fields = calloc(count, sizeof *fields);
    if (handles == NULL || fields == NULL) {
      free(handles);
      free(fields);
      return number_of(env, preparing ? -NARSIL_OUT_OF_MEMORY : NARSIL_OUT_OF_MEMORY);
    }
  }
  size_t written = 0;
  narsil_status status = apply(env, thread, argv, count, handles, fields, preparing, &written);
  if (count > STACK_FIELDS) {
    free(handles);
    free(fields);
  }
  report_workspace_memory(env, thread);
  if (!preparing) { return status_of(env, status); }
  if (status != NARSIL_OK) { return number_of(env, -(int32_t)status); }
  napi_value result = NULL;
  return napi_create_double(env, (double)written, &result) == napi_ok ? result : NULL;
}

napi_value remove_frozen_document(napi_env env, napi_callback_info info) { return mutate(env, info, 0); }
napi_value prepare_frozen_removal(napi_env env, napi_callback_info info) { return mutate(env, info, 1); }
