#include "pattern.h"

#include "stored_values.h"
#include "values.h"

#include "../include/narsil_core.h"
#include "../include/narsil_pattern.h"
#include "../include/narsil_stored_values.h"
#include "../include/narsil_work.h"
#include "../src/regions.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <stddef.h>
#include <stdint.h>

enum { DOCUMENTS, RUNS, OFFSETS, POSTINGS, VALUES, TEXT, OPTIONS, METER, STOP, DEADLINE, INTO, ARGUMENT_COUNT };
enum { OPERATOR, CASE_FOLD, TOLERANCE, COUNT_PREPARATION, MATCHER_BYTES, OPTION_COUNT };

static int controls_valid(void *const *data, const size_t *lengths) {
  if (lengths[OPTIONS] != OPTION_COUNT || lengths[METER] != 2 || lengths[STOP] != 1 || lengths[DEADLINE] != 1) {
    return 0;
  }
  memory_region output;
  memory_region spent;
  memory_region options;
  memory_region deadline;
  memory_region cap;
  int64_t *meter = data[METER];
  return region_of(data[INTO], lengths[INTO], sizeof(uint32_t), &output) &&
         region_of(meter, 1, sizeof *meter, &spent) && region_of(meter + 1, 1, sizeof *meter, &cap) &&
         region_of(data[OPTIONS], OPTION_COUNT, sizeof(uint32_t), &options) &&
         region_of(data[DEADLINE], 1, sizeof(uint64_t), &deadline) && !overlaps(output, options) &&
         !overlaps(output, deadline) && !overlaps(output, cap) && !overlaps(spent, options) &&
         !overlaps(spent, deadline) && !overlaps(spent, cap);
}

static narsil_status execute(napi_env env, thread_state *state, const napi_value *argv,
                             const stored_field_handles *handles) {
  static const napi_typedarray_type types[ARGUMENT_COUNT] = {
      napi_uint32_array, napi_uint32_array,    napi_uint32_array, napi_uint32_array,
      napi_uint8_array,  napi_uint16_array,    napi_uint32_array, napi_bigint64_array,
      napi_uint32_array, napi_biguint64_array, napi_uint32_array};
  void *data[ARGUMENT_COUNT] = {0};
  size_t lengths[ARGUMENT_COUNT] = {0};
  narsil_stored_values values = {0};
  if (!read_stored_field(env, handles, &values)) { return NARSIL_INVALID_ARGUMENT; }
  for (size_t at = 0; at < ARGUMENT_COUNT; at++) {
    if (at == VALUES) { continue; }
    if (!possibly_empty_typed_data(env, argv[at], types[at], &data[at], &lengths[at])) {
      return NARSIL_INVALID_ARGUMENT;
    }
  }
  if (!controls_valid(data, lengths)) { return NARSIL_INVALID_ARGUMENT; }
  const uint32_t *options = data[OPTIONS];
  int64_t *counts = data[METER];
  const uint64_t *deadline = data[DEADLINE];
  narsil_pattern_index index = {{data[DOCUMENTS], lengths[DOCUMENTS]},
                                {data[RUNS], lengths[RUNS]},
                                {data[OFFSETS], lengths[OFFSETS]},
                                {data[POSTINGS], lengths[POSTINGS]}};
  narsil_pattern_test test = {data[TEXT],
                              lengths[TEXT],
                              options[OPERATOR],
                              options[CASE_FOLD],
                              options[TOLERANCE],
                              options[COUNT_PREPARATION],
                              options[MATCHER_BYTES]};
  narsil_work_meter meter = {counts, counts[1], data[STOP], deadline[0]};
  return narsil_pattern_match(state->workspace, &index, &values, &test, &meter, data[INTO], lengths[INTO]);
}

static napi_value pattern_test(napi_env env, napi_callback_info info) {
  napi_value argv[ARGUMENT_COUNT];
  stored_field_handles handles;
  thread_state *state = thread_state_of(env);
  if (state == NULL || !callback_arguments(env, info, ARGUMENT_COUNT, argv) ||
      !prepare_stored_field(env, argv[VALUES], &handles)) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  narsil_status status = execute(env, state, argv, &handles);
  report_workspace_memory(env, state);
  return number_of(env, -(int32_t)status);
}

static napi_value clock_now(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  void *data = NULL;
  size_t count = 0;
  if (!callback_arguments(env, info, 1, argv) || !typed_data(env, argv[0], napi_biguint64_array, &data, &count)) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  uint64_t *output = data;
  output[0] = narsil_clock_now();
  return number_of(env, NARSIL_OK);
}

int define_pattern(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"patternTest", NULL, pattern_test, NULL, NULL, NULL, napi_default_method, NULL},
      {"clockNow", NULL, clock_now, NULL, NULL, NULL, napi_default_method, NULL},
  };
  return napi_define_properties(env, exports, sizeof properties / sizeof properties[0], properties) == napi_ok;
}
