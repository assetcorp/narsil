#include "phrases.h"

#include "../include/narsil_core.h"
#include "../include/narsil_phrases.h"
#include "../include/narsil_work.h"
#include "../src/regions.h"
#include "phrase_values.h"
#include "values.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <stddef.h>
#include <stdint.h>

enum { REQUEST, METER, STOP, DEADLINE, MATCHED, STARTS, DOCUMENTS, FIELDS, FREQUENCIES, ARGUMENT_COUNT };

static int controls_valid(void *const *data, const size_t *lengths) {
  if (lengths[METER] != 2 || lengths[STOP] != 1 || lengths[DEADLINE] != 1) { return 0; }
  int64_t *meter = data[METER];
  memory_region cap;
  memory_region deadline;
  memory_region spent;
  if (!region_of(meter + 1, 1, sizeof *meter, &cap) || !region_of(data[DEADLINE], 1, sizeof(uint64_t), &deadline) ||
      !region_of(meter, 1, sizeof *meter, &spent) || overlaps(spent, cap) || overlaps(spent, deadline)) {
    return 0;
  }
  for (size_t at = MATCHED; at < ARGUMENT_COUNT; at++) {
    memory_region output;
    size_t width = at == FIELDS ? sizeof(uint16_t) : sizeof(uint32_t);
    if (!region_of(data[at], lengths[at], width, &output) || overlaps(output, cap) || overlaps(output, deadline)) {
      return 0;
    }
  }
  return 1;
}

static narsil_status execute(napi_env env, thread_state *state, const napi_value *argv, const phrase_handles *handles,
                             uint32_t *count) {
  narsil_phrase_request request;
  if (!read_phrase_handles(env, handles, &request)) { return NARSIL_INVALID_ARGUMENT; }
  void *data[ARGUMENT_COUNT] = {0};
  size_t lengths[ARGUMENT_COUNT] = {0};
  for (size_t at = METER; at < ARGUMENT_COUNT; at++) {
    napi_typedarray_type type = napi_uint32_array;
    if (at == METER) { type = napi_bigint64_array; }
    if (at == DEADLINE) { type = napi_biguint64_array; }
    if (at == FIELDS) { type = napi_uint16_array; }
    if (!possibly_empty_typed_data(env, argv[at], type, &data[at], &lengths[at])) { return NARSIL_INVALID_ARGUMENT; }
  }
  if (!controls_valid(data, lengths)) { return NARSIL_INVALID_ARGUMENT; }
  int64_t *meter = data[METER];
  const uint64_t *deadline = data[DEADLINE];
  request.meter = (narsil_work_meter){meter, meter[1], data[STOP], deadline[0]};
  narsil_phrase_output output = {data[MATCHED],   lengths[MATCHED],    data[STARTS],      lengths[STARTS],
                                 data[DOCUMENTS], data[FIELDS],        data[FREQUENCIES], lengths[DOCUMENTS],
                                 lengths[FIELDS], lengths[FREQUENCIES]};
  return narsil_match_phrases(state->workspace, &request, &output, count);
}

static napi_value match(napi_env env, napi_callback_info info) {
  napi_value argv[ARGUMENT_COUNT];
  thread_state *state = thread_state_of(env);
  if (state == NULL || !callback_arguments(env, info, ARGUMENT_COUNT, argv)) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  phrase_handles handles = {0};
  narsil_status status = prepare_phrase_handles(env, argv[REQUEST], &handles);
  uint32_t count = 0;
  if (status == NARSIL_OK) { status = execute(env, state, argv, &handles, &count); }
  release_phrase_handles(&handles);
  report_workspace_memory(env, state);
  if (status != NARSIL_OK) { return number_of(env, -(int32_t)status); }
  napi_value result;
  if (napi_create_uint32(env, count, &result) != napi_ok) { return NULL; }
  return result;
}

int define_phrases(napi_env env, napi_value exports) {
  napi_property_descriptor property = {"matchPhrases", NULL, match, NULL, NULL, NULL, napi_default_method, NULL};
  return napi_define_properties(env, exports, 1, &property) == napi_ok;
}
