#include "pages.h"

#include "values.h"

#include "../include/narsil_core.h"
#include "../include/narsil_pages.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <math.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

enum { PAGE_COUNT, PAGE_SORTED, PAGE_SCORES, PAGE_PRESENT, PAGE_AFTER, PAGE_ANCHOR, PAGE_ARGUMENT_COUNT };

static int nullable_array(napi_env env, napi_value value, napi_typedarray_type type, void **data, size_t *length,
                          uint32_t *present) {
  napi_valuetype value_type = napi_undefined;
  if (napi_typeof(env, value, &value_type) != napi_ok) { return 0; }
  *present = value_type != napi_null;
  return *present == 0 || possibly_empty_typed_data(env, value, type, data, length);
}

static napi_value page_start(napi_env env, napi_callback_info info) {
  napi_value argv[PAGE_ARGUMENT_COUNT];
  narsil_page_request request = {0};
  double count = 0;
  bool sorted = false;
  void *scores = NULL;
  void *present = NULL;
  void *after = NULL;
  uint32_t has_present = 0;
  napi_valuetype anchor_type = napi_undefined;
  if (!callback_arguments(env, info, PAGE_ARGUMENT_COUNT, argv) ||
      napi_get_value_double(env, argv[PAGE_COUNT], &count) != napi_ok || !isfinite(count) || count < 0 ||
      count > UINT32_MAX || count != floor(count) || napi_get_value_bool(env, argv[PAGE_SORTED], &sorted) != napi_ok ||
      !nullable_array(env, argv[PAGE_SCORES], napi_float64_array, &scores, &request.scores_length,
                      &request.has_scores) ||
      !nullable_array(env, argv[PAGE_PRESENT], napi_uint32_array, &present, &request.score_present_length,
                      &has_present) ||
      !typed_data(env, argv[PAGE_AFTER], napi_uint32_array, &after, &request.after_anchor_length) ||
      napi_typeof(env, argv[PAGE_ANCHOR], &anchor_type) != napi_ok) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  request.has_anchor_score = anchor_type != napi_null;
  if (request.has_anchor_score != 0 &&
      napi_get_value_double(env, argv[PAGE_ANCHOR], &request.anchor_score) != napi_ok) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  if (has_present != 0 && (request.has_scores == 0 || request.score_present_length == 0)) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  request.count = (uint32_t)count;
  request.sorted = (uint32_t)sorted;
  request.scores = scores;
  request.score_present = present;
  request.after_anchor = after;
  uint32_t start = 0;
  narsil_status status = narsil_page_start(&request, &start);
  if (status != NARSIL_OK) { return number_of(env, -(int32_t)status); }
  napi_value result = NULL;
  if (napi_create_uint32(env, start, &result) != napi_ok) { return NULL; }
  return result;
}

int define_pages(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"pageStart", NULL, page_start, NULL, NULL, NULL, napi_default_method, NULL},
  };
  return napi_define_properties(env, exports, sizeof properties / sizeof properties[0], properties) == napi_ok;
}
