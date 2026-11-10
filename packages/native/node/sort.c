#include "sort.h"
#include "sort_values.h"

#include "stored_values.h"
#include "values.h"

#include "../include/narsil_core.h"
#include "../include/narsil_sort.h"
#include "../include/narsil_stored_values.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <math.h>
#include <stddef.h>
#include <stdint.h>

enum { VALUES, ORDINAL, MODE, NUMBER, TEXT, ARGUMENT_COUNT };

static int unsigned_value(napi_env env, napi_value value, uint32_t *out) {
  double number = 0;
  if (napi_get_value_double(env, value, &number) != napi_ok || !isfinite(number) || number < 0 || number > UINT32_MAX ||
      number != floor(number)) {
    return 0;
  }
  *out = (uint32_t)number;
  return 1;
}

static napi_value sort_value(napi_env env, napi_callback_info info) {
  napi_value argv[ARGUMENT_COUNT];
  uint32_t ordinal = 0;
  uint32_t mode = 0;
  stored_field_handles handles = {0};
  thread_state *state = thread_state_of(env);
  if (state == NULL || !callback_arguments(env, info, ARGUMENT_COUNT, argv) ||
      !unsigned_value(env, argv[ORDINAL], &ordinal) || !unsigned_value(env, argv[MODE], &mode) ||
      !prepare_stored_field(env, argv[VALUES], &handles)) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  narsil_stored_values values = {0};
  narsil_sort_value_output output = {0};
  void *number = NULL;
  void *text = NULL;
  if (!read_stored_field(env, &handles, &values) ||
      !possibly_empty_typed_data(env, argv[NUMBER], napi_float64_array, &number, &output.number_capacity) ||
      !possibly_empty_typed_data(env, argv[TEXT], napi_uint32_array, &text, &output.text_capacity)) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  output.number = number;
  output.text = text;
  narsil_status status = narsil_sort_value(state->workspace, &values, ordinal, mode, &output);
  report_workspace_memory(env, state);
  return number_of(env, status == NARSIL_OK ? (int32_t)output.kind : -(int32_t)status);
}

int define_sort(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"sortValue", NULL, sort_value, NULL, NULL, NULL, napi_default_method, NULL},
      {"buildSortOrder", NULL, build_sort_order, NULL, NULL, NULL, napi_default_method, NULL},
      {"textRange", NULL, text_range, NULL, NULL, NULL, napi_default_method, NULL},
      {"sortSelect", NULL, sort_select, NULL, NULL, NULL, napi_default_method, NULL},
  };
  return napi_define_properties(env, exports, sizeof properties / sizeof properties[0], properties) == napi_ok;
}
