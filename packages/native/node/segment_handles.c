#include "segments.h"

#include "terms.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <math.h>
#include <stddef.h>
#include <stdint.h>

static const char *const COLUMN_PROPERTIES[SEGMENT_COLUMN_HANDLES] = {
    "sliceStart",         "sliceClass",         "lengths",  "docFrequency", "deadDocuments",
    "totalTermFrequency", "surfaceOccurrences", "revision", "flags",
};
static const char *const POSTING_PROPERTIES[SEGMENT_POSTING_HANDLES] = {
    "docIds", "frequencies", "fieldIndices", "positionStarts", "allocation", "freeHeads", "sliceCapacities",
};
static const char *const VALUE_PROPERTIES[SEGMENT_VALUE_HANDLES] = {
    "retired", "fieldLengths", "totalDocuments", "totalFieldLengths", "partialFields",
};
static const char *const RUN_PROPERTIES[SEGMENT_RUN_HANDLES] = {
    "header",    "slots",   "runs",       "listStart", "listLength",
    "listClass", "members", "allocation", "freeHeads", "sliceCapacities",
};

int segment_uint_argument(napi_env env, napi_value value, uint32_t *number) {
  double read = 0;
  if (napi_get_value_double(env, value, &read) != napi_ok || !isfinite(read) || read < 0 || read > UINT32_MAX ||
      read != floor(read)) {
    return 0;
  }
  *number = (uint32_t)read;
  return 1;
}

static int prepare_arrays(napi_env env, napi_value value, const char *const *properties, size_t count,
                          napi_value *handles) {
  for (size_t index = 0; index < count; index++) {
    if (napi_get_named_property(env, value, properties[index], &handles[index]) != napi_ok) { return 0; }
  }
  return 1;
}

static int prepare_surface(napi_env env, napi_value value, surface_handles *handles) {
  napi_value strings = NULL;
  return napi_get_named_property(env, value, "strings", &strings) == napi_ok &&
         prepare_term_table(env, strings, handles->strings) &&
         napi_get_named_property(env, value, "token", &handles->token) == napi_ok &&
         napi_get_named_property(env, value, "count", &handles->count) == napi_ok;
}

static int optional_property(napi_env env, napi_value parent, const char *property, napi_value *value, int *present) {
  napi_valuetype type = napi_undefined;
  if (napi_get_named_property(env, parent, property, value) != napi_ok || napi_typeof(env, *value, &type) != napi_ok) {
    return 0;
  }
  if (type != napi_null && type != napi_object) { return 0; }
  *present = type != napi_null;
  return 1;
}

static int prepare_optional(napi_env env, napi_value value, segment_handles *handles) {
  napi_value positions = NULL;
  napi_value surfaces = NULL;
  napi_value spellings = NULL;
  napi_value runs = NULL;
  if (!optional_property(env, value, "positions", &positions, &handles->has_positions) ||
      !optional_property(env, value, "surfaces", &surfaces, &handles->has_surfaces) ||
      !optional_property(env, value, "spellings", &spellings, &handles->has_spellings)) {
    return 0;
  }
  if (handles->has_positions &&
      (napi_get_named_property(env, positions, "values", &handles->positions) != napi_ok ||
       napi_get_named_property(env, positions, "allocation", &handles->position_allocation) != napi_ok)) {
    return 0;
  }
  if (handles->has_surfaces && !prepare_surface(env, surfaces, &handles->surfaces)) { return 0; }
  if (handles->has_spellings &&
      (!prepare_surface(env, spellings, &handles->spellings) ||
       napi_get_named_property(env, spellings, "codePoints", &handles->code_points) != napi_ok ||
       napi_get_named_property(env, spellings, "runs", &runs) != napi_ok ||
       !prepare_arrays(env, runs, RUN_PROPERTIES, SEGMENT_RUN_HANDLES, handles->runs))) {
    return 0;
  }
  return 1;
}

int prepare_segment(napi_env env, napi_value value, segment_handles *handles) {
  napi_value terms = NULL;
  napi_value columns = NULL;
  napi_value postings = NULL;
  napi_value capacity = NULL;
  return napi_get_named_property(env, value, "terms", &terms) == napi_ok &&
         prepare_term_table(env, terms, handles->terms) &&
         napi_get_named_property(env, value, "columns", &columns) == napi_ok &&
         prepare_arrays(env, columns, COLUMN_PROPERTIES, SEGMENT_COLUMN_HANDLES, handles->columns) &&
         napi_get_named_property(env, value, "postings", &postings) == napi_ok &&
         prepare_arrays(env, postings, POSTING_PROPERTIES, SEGMENT_POSTING_HANDLES, handles->postings) &&
         prepare_arrays(env, value, VALUE_PROPERTIES, SEGMENT_VALUE_HANDLES, handles->values) &&
         napi_get_named_property(env, value, "ordinalCapacity", &capacity) == napi_ok &&
         segment_uint_argument(env, capacity, &handles->ordinal_capacity) && prepare_optional(env, value, handles);
}
