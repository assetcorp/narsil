#include "groups.h"

#include "stored_values.h"
#include "values.h"

#include "../include/narsil_core.h"
#include "../include/narsil_groups.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <math.h>
#include <stddef.h>
#include <stdint.h>

enum { VALUES, ORDINALS, SCORES, ID_RANKS, MAXIMUM, LIMIT, HEADS, OFFSETS, HITS, MEMBERS, ARGUMENT_COUNT };
enum { OUT_HEADS = 3, OUT_OFFSETS, OUT_HITS, OUT_MEMBERS, GROUP_ARRAYS };

static int unsigned_value(napi_env env, napi_value value, uint32_t *out) {
  double number = 0;
  if (napi_get_value_double(env, value, &number) != napi_ok || !isfinite(number) || number < 0 || number > UINT32_MAX ||
      number != floor(number)) {
    return 0;
  }
  *out = (uint32_t)number;
  return 1;
}

static int read_arguments(napi_env env, const napi_value argv[ARGUMENT_COUNT], narsil_group_request *request,
                          narsil_group_output *output) {
  const uint32_t indices[GROUP_ARRAYS] = {ORDINALS, SCORES, ID_RANKS, HEADS, OFFSETS, HITS, MEMBERS};
  void *data[GROUP_ARRAYS] = {0};
  size_t lengths[GROUP_ARRAYS] = {0};
  for (size_t region = 0; region < GROUP_ARRAYS; region++) {
    napi_typedarray_type type = region == 1 ? napi_float64_array : napi_uint32_array;
    if (!possibly_empty_typed_data(env, argv[indices[region]], type, &data[region], &lengths[region])) { return 0; }
  }
  request->ordinals = data[0];
  request->ordinal_count = lengths[0];
  request->scores = data[1];
  request->score_count = lengths[1];
  request->id_ranks = data[2];
  request->id_rank_count = lengths[2];
  output->heads = data[OUT_HEADS];
  output->head_capacity = lengths[OUT_HEADS];
  output->offsets = data[OUT_OFFSETS];
  output->offset_capacity = lengths[OUT_OFFSETS];
  output->hits = data[OUT_HITS];
  output->hit_capacity = lengths[OUT_HITS];
  output->members = data[OUT_MEMBERS];
  output->member_capacity = lengths[OUT_MEMBERS];
  return 1;
}

static napi_value group_hits(napi_env env, napi_callback_info info) {
  napi_value argv[ARGUMENT_COUNT];
  narsil_group_request request = {0};
  narsil_group_output output = {0};
  napi_valuetype limit_type = napi_undefined;
  thread_state *state = thread_state_of(env);
  if (state == NULL || !callback_arguments(env, info, ARGUMENT_COUNT, argv) ||
      !unsigned_value(env, argv[MAXIMUM], &request.max_per_group) ||
      napi_typeof(env, argv[LIMIT], &limit_type) != napi_ok) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  request.has_limit = limit_type != napi_null;
  if (request.has_limit != 0 && !unsigned_value(env, argv[LIMIT], &request.limit)) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  stored_fields fields = {0};
  narsil_status status = prepare_stored_fields(env, argv[VALUES], &fields);
  if (status == NARSIL_OK) {
    if (!read_stored_fields(env, &fields) || !read_arguments(env, argv, &request, &output)) {
      status = NARSIL_INVALID_ARGUMENT;
    } else {
      request.values = fields.values;
      request.value_count = fields.count;
      status = narsil_group_hits(state->workspace, &request, &output);
    }
  }
  release_stored_fields(&fields);
  report_workspace_memory(env, state);
  if (status != NARSIL_OK) { return number_of(env, -(int32_t)status); }
  napi_value result = NULL;
  if (napi_create_uint32(env, output.count, &result) != napi_ok) { return NULL; }
  return result;
}

int define_groups(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"groupHits", NULL, group_hits, NULL, NULL, NULL, napi_default_method, NULL},
  };
  return napi_define_properties(env, exports, sizeof properties / sizeof properties[0], properties) == napi_ok;
}
