#include "segment_merge.h"

#include "segments.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

static const char *const STRING_PROPERTIES[MERGE_STRING_HANDLES] = {"text", "offsets", "counts"};
static const char *const INPUT_PROPERTIES[MERGE_INPUT_HANDLES] = {
    "payloadSlots",    "postingOffsets", "postingDocuments", "postingFrequencies", "postingFields",
    "positionOffsets", "positionValues", "mapping",          "fieldMapping"};
static const char *const OUTPUT_PROPERTIES[MERGE_OUTPUT_HANDLES] = {
    "postingOffsets",  "postingDocuments", "postingFrequencies", "postingFields",
    "positionOffsets", "positionValues",   "fieldLengths",       "totalFieldLengths"};

static int properties(napi_env env, napi_value value, const char *const *keys, size_t count, napi_value *handles) {
  for (size_t at = 0; at < count; at++) {
    if (napi_get_named_property(env, value, keys[at], handles + at) != napi_ok) { return 0; }
  }
  return 1;
}

static int strings(napi_env env, napi_value value, const char *key, napi_value *handles, int *present) {
  napi_value object = NULL;
  napi_valuetype type = napi_undefined;
  if (napi_get_named_property(env, value, key, &object) != napi_ok || napi_typeof(env, object, &type) != napi_ok) {
    return 0;
  }
  if (type == napi_null && present != NULL) {
    *present = 0;
    return 1;
  }
  if (type != napi_object) { return 0; }
  if (present != NULL) { *present = 1; }
  return properties(env, object, STRING_PROPERTIES, MERGE_STRING_HANDLES, handles);
}

int prepare_merge_strings(napi_env env, napi_value value, napi_value *handles) {
  napi_valuetype type = napi_undefined;
  return napi_typeof(env, value, &type) == napi_ok && type == napi_object &&
         properties(env, value, STRING_PROPERTIES, MERGE_STRING_HANDLES, handles);
}

int prepare_merge_input(napi_env env, napi_value value, merge_input_handles *handles) {
  napi_value count = NULL;
  napi_value lengths = NULL;
  napi_value growing = NULL;
  napi_valuetype growing_type = napi_undefined;
  bool array = false;
  if (napi_get_named_property(env, value, "growing", &growing) != napi_ok ||
      napi_typeof(env, growing, &growing_type) != napi_ok) {
    return 0;
  }
  handles->has_growing = growing_type != napi_undefined && growing_type != napi_null;
  if (handles->has_growing && !prepare_segment(env, growing, &handles->growing)) { return 0; }
  if ((!handles->has_growing && !strings(env, value, "terms", handles->terms, NULL)) ||
      !strings(env, value, "surfaces", handles->surfaces, &handles->has_surfaces) ||
      !strings(env, value, "spellings", handles->spellings, &handles->has_spellings) ||
      !properties(env, value, INPUT_PROPERTIES, MERGE_INPUT_HANDLES, handles->arrays) ||
      napi_get_named_property(env, value, "documentCount", &count) != napi_ok ||
      !segment_uint_argument(env, count, &handles->document_count) ||
      napi_get_named_property(env, value, "fieldLengths", &lengths) != napi_ok ||
      napi_is_array(env, lengths, &array) != napi_ok || !array ||
      napi_get_array_length(env, lengths, &handles->field_count) != napi_ok ||
      handles->field_count > (uint32_t)UINT16_MAX + 1) {
    return 0;
  }
  if (handles->field_count > 0) {
    handles->lengths = (napi_value *)calloc(handles->field_count, sizeof *handles->lengths);
    if (handles->lengths == NULL) {
      handles->out_of_memory = 1;
      return 0;
    }
    for (uint32_t at = 0; at < handles->field_count; at++) {
      if (napi_get_element(env, lengths, at, handles->lengths + at) != napi_ok) { return 0; }
    }
  }
  return 1;
}

int prepare_merge_output(napi_env env, napi_value value, merge_output_handles *handles) {
  return strings(env, value, "terms", handles->terms, NULL) &&
         strings(env, value, "surfaces", handles->surfaces, NULL) &&
         strings(env, value, "spellings", handles->spellings, NULL) &&
         properties(env, value, OUTPUT_PROPERTIES, MERGE_OUTPUT_HANDLES, handles->arrays);
}
