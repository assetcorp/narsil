#include "values.h"

#include "field.h"
#include "host_api.h"

#include "../include/narsil_core.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <node_api.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

enum { ATTACH_MEMORY, ATTACH_ARGUMENT_COUNT };

enum {
  SEARCH_FIELD,
  SEARCH_QUERY,
  SEARCH_METRIC,
  SEARCH_CANDIDATE_COUNT,
  SEARCH_THREAD_SLOT,
  SEARCH_ORDINALS,
  SEARCH_DISTANCES,
  SEARCH_ARGUMENT_COUNT
};

enum {
  PLACE_FIELD,
  PLACE_VECTOR,
  PLACE_METRIC,
  PLACE_OWN_ORDINAL,
  PLACE_TOP_LAYER,
  PLACE_THREAD_SLOT,
  PLACE_ORDINALS,
  PLACE_DISTANCES,
  PLACE_LAYER_COUNTS,
  PLACE_ARGUMENT_COUNT
};

enum {
  RESCORE_FIELD,
  RESCORE_QUERY,
  RESCORE_METRIC,
  RESCORE_ORDINALS,
  RESCORE_COUNT,
  RESCORE_DISTANCES,
  RESCORE_ARGUMENT_COUNT
};

typedef struct {
  narsil_workspace *workspace;
  int64_t reported_bytes;
} thread_state;

static int callback_arguments(napi_env env, napi_callback_info info, size_t expected, napi_value *argv) {
  size_t argc = expected;
  return napi_get_cb_info(env, info, &argc, argv, NULL, NULL) == napi_ok && argc == expected;
}

static napi_value attach(napi_env env, napi_callback_info info) {
  napi_value argv[ATTACH_ARGUMENT_COUNT];
  if (!callback_arguments(env, info, ATTACH_ARGUMENT_COUNT, argv)) {
    return throw_error(env, "attach takes the memory of one field");
  }
  attached_field *field = read_field(env, argv[ATTACH_MEMORY]);
  if (field == NULL) { return throw_error(env, "the field memory is invalid, or attach cannot allocate the field"); }
  napi_value handle = NULL;
  if (napi_create_reference(env, argv[ATTACH_MEMORY], 1, &field->memory) != napi_ok ||
      napi_create_external(env, field, release_field, NULL, &handle) != napi_ok) {
    release_field(env, field, NULL);
    return throw_error(env, "attach cannot create the field handle");
  }
  return handle;
}

static attached_field *field_of(napi_env env, napi_value value) {
  void *data = NULL;
  if (napi_get_value_external(env, value, &data) != napi_ok) { return NULL; }
  return data;
}

static thread_state *thread_state_of(napi_env env) {
  void *data = NULL;
  if (napi_get_instance_data(env, &data) != napi_ok) { return NULL; }
  return data;
}

static void report_workspace_memory(napi_env env, thread_state *state) {
  int64_t held = (int64_t)narsil_workspace_bytes(state->workspace);
  if (held == state->reported_bytes) { return; }
  int64_t adjusted = 0;
  if (napi_adjust_external_memory(env, held - state->reported_bytes, &adjusted) == napi_ok) {
    state->reported_bytes = held;
  }
}

static napi_value search(napi_env env, napi_callback_info info) {
  napi_value argv[SEARCH_ARGUMENT_COUNT];
  attached_field *field =
      callback_arguments(env, info, SEARCH_ARGUMENT_COUNT, argv) ? field_of(env, argv[SEARCH_FIELD]) : NULL;
  thread_state *state = thread_state_of(env);
  if (field == NULL || state == NULL) { return throw_error(env, "search takes a field handle and six arguments"); }
  void *query = NULL;
  void *ordinals = NULL;
  void *distances = NULL;
  size_t query_length = 0;
  size_t ordinal_capacity = 0;
  size_t distance_capacity = 0;
  narsil_search_request request = {NULL, NARSIL_METRIC_COSINE, 0, 0};
  if (!typed_data(env, argv[SEARCH_QUERY], napi_float32_array, &query, &query_length) ||
      napi_get_value_uint32(env, argv[SEARCH_METRIC], &request.metric) != napi_ok ||
      napi_get_value_uint32(env, argv[SEARCH_CANDIDATE_COUNT], &request.candidate_count) != napi_ok ||
      napi_get_value_uint32(env, argv[SEARCH_THREAD_SLOT], &request.thread_slot) != napi_ok ||
      !typed_data(env, argv[SEARCH_ORDINALS], napi_int32_array, &ordinals, &ordinal_capacity) ||
      !typed_data(env, argv[SEARCH_DISTANCES], napi_float64_array, &distances, &distance_capacity)) {
    return throw_error(env, "an argument to search has the wrong type");
  }
  if (query_length != field->store.dimension) { return throw_error(env, "the query has the wrong dimension"); }
  uint32_t capacity = clamped_count(ordinal_capacity < distance_capacity ? ordinal_capacity : distance_capacity);
  if (capacity < request.candidate_count) {
    return throw_error(env, "the result arrays hold fewer entries than the candidate count");
  }
  request.query = query;
  narsil_candidates nearest = {ordinals, distances, capacity, 0};
  narsil_status status = narsil_search(state->workspace, &field->graph, &field->store, &request, &nearest);
  report_workspace_memory(env, state);
  if (status != NARSIL_OK) { return number_of(env, -(int32_t)status); }
  return number_of(env, (int32_t)nearest.count);
}

static int read_place_request(napi_env env, const napi_value *argv, const attached_field *field,
                              narsil_place_request *request) {
  void *vector = NULL;
  size_t vector_length = 0;
  if (!typed_data(env, argv[PLACE_VECTOR], napi_float32_array, &vector, &vector_length) ||
      napi_get_value_uint32(env, argv[PLACE_METRIC], &request->metric) != napi_ok ||
      napi_get_value_int32(env, argv[PLACE_OWN_ORDINAL], &request->own_ordinal) != napi_ok ||
      napi_get_value_int32(env, argv[PLACE_TOP_LAYER], &request->top_layer) != napi_ok ||
      napi_get_value_uint32(env, argv[PLACE_THREAD_SLOT], &request->thread_slot) != napi_ok) {
    return 0;
  }
  request->vector = vector;
  return vector_length == field->store.dimension;
}

static napi_value place(napi_env env, napi_callback_info info) {
  napi_value argv[PLACE_ARGUMENT_COUNT];
  attached_field *field =
      callback_arguments(env, info, PLACE_ARGUMENT_COUNT, argv) ? field_of(env, argv[PLACE_FIELD]) : NULL;
  thread_state *state = thread_state_of(env);
  if (field == NULL || state == NULL) { return throw_error(env, "place takes a field handle and eight arguments"); }
  narsil_place_request request = {NULL, NARSIL_METRIC_COSINE, 0, 0, 0};
  void *ordinals = NULL;
  void *distances = NULL;
  void *counts = NULL;
  size_t ordinal_capacity = 0;
  size_t distance_capacity = 0;
  size_t layer_count = 0;
  if (!read_place_request(env, argv, field, &request) ||
      !typed_data(env, argv[PLACE_ORDINALS], napi_int32_array, &ordinals, &ordinal_capacity) ||
      !typed_data(env, argv[PLACE_DISTANCES], napi_float64_array, &distances, &distance_capacity) ||
      !typed_data(env, argv[PLACE_LAYER_COUNTS], napi_int32_array, &counts, &layer_count)) {
    return throw_error(env, "an argument to place has the wrong type, or the vector has the wrong dimension");
  }
  if (layer_count == 0 || layer_count > NARSIL_MAX_PLACEMENT_LAYERS) {
    return throw_error(env, "place takes at least one layer, and no more layers than the core holds room for");
  }
  size_t per_layer_capacity =
      (ordinal_capacity < distance_capacity ? ordinal_capacity : distance_capacity) / layer_count;
  narsil_candidates per_layer[NARSIL_MAX_PLACEMENT_LAYERS];
  for (size_t layer = 0; layer < layer_count; layer++) {
    per_layer[layer].ordinals = (int32_t *)ordinals + (layer * per_layer_capacity);
    per_layer[layer].distances = (double *)distances + (layer * per_layer_capacity);
    per_layer[layer].capacity = clamped_count(per_layer_capacity);
    per_layer[layer].count = 0;
  }
  narsil_placement placement = {per_layer, (uint32_t)layer_count, -1};
  narsil_status status = narsil_place(state->workspace, &field->graph, &field->store, &request, &placement);
  report_workspace_memory(env, state);
  if (status != NARSIL_OK) { return number_of(env, -(int32_t)status); }
  for (size_t layer = 0; layer < layer_count; layer++) { ((int32_t *)counts)[layer] = (int32_t)per_layer[layer].count; }
  int32_t linked = placement.linked_top_layer < 0 ? -1 : placement.linked_top_layer;
  return number_of(env, linked + 1);
}

static napi_value rescore(napi_env env, napi_callback_info info) {
  napi_value argv[RESCORE_ARGUMENT_COUNT];
  attached_field *field =
      callback_arguments(env, info, RESCORE_ARGUMENT_COUNT, argv) ? field_of(env, argv[RESCORE_FIELD]) : NULL;
  if (field == NULL) { return throw_error(env, "rescore takes a field handle and five arguments"); }
  void *query = NULL;
  void *ordinals = NULL;
  void *distances = NULL;
  size_t query_length = 0;
  size_t ordinal_length = 0;
  size_t distance_length = 0;
  uint32_t metric = 0;
  uint32_t count = 0;
  if (!typed_data(env, argv[RESCORE_QUERY], napi_float32_array, &query, &query_length) ||
      napi_get_value_uint32(env, argv[RESCORE_METRIC], &metric) != napi_ok ||
      !typed_data(env, argv[RESCORE_ORDINALS], napi_int32_array, &ordinals, &ordinal_length) ||
      napi_get_value_uint32(env, argv[RESCORE_COUNT], &count) != napi_ok ||
      !typed_data(env, argv[RESCORE_DISTANCES], napi_float64_array, &distances, &distance_length)) {
    return throw_error(env, "an argument to rescore has the wrong type");
  }
  if (query_length != field->store.dimension) { return throw_error(env, "the query has the wrong dimension"); }
  if (count > ordinal_length || count > distance_length) {
    return throw_error(env, "the arrays passed to rescore are shorter than the count");
  }
  narsil_status status = narsil_rescore(&field->store, query, metric, ordinals, count, distances);
  return number_of(env, -(int32_t)status);
}

static napi_value abi_version(napi_env env, napi_callback_info info) {
  (void)info;
  return number_of(env, narsil_core_abi_version());
}

static napi_value workspace_bytes(napi_env env, napi_callback_info info) {
  (void)info;
  thread_state *state = thread_state_of(env);
  if (state == NULL) { return throw_error(env, "the native search core has no workspace on this thread"); }
  napi_value result = NULL;
  if (napi_create_double(env, (double)narsil_workspace_bytes(state->workspace), &result) != napi_ok) { return NULL; }
  return result;
}

static void release_thread_state(napi_env env, void *finalize_data, void *finalize_hint) {
  (void)env;
  (void)finalize_hint;
  thread_state *state = finalize_data;
  narsil_workspace_destroy(state->workspace);
  free(state);
}

static napi_value initialise(napi_env env, napi_value exports) {
  if (!host_api_ready()) { return NULL; }
  thread_state *state = calloc(1, sizeof *state);
  if (state == NULL || narsil_workspace_create(&state->workspace) != NARSIL_OK) {
    free(state);
    return throw_error(env, "the native search core cannot allocate a workspace for this thread");
  }
  if (napi_set_instance_data(env, state, release_thread_state, NULL) != napi_ok) {
    release_thread_state(env, state, NULL);
    return throw_error(env, "the native search core cannot store the workspace for this thread");
  }
  napi_property_descriptor properties[] = {
      {"abiVersion", NULL, abi_version, NULL, NULL, NULL, napi_default_method, NULL},
      {"attach", NULL, attach, NULL, NULL, NULL, napi_default_method, NULL},
      {"search", NULL, search, NULL, NULL, NULL, napi_default_method, NULL},
      {"place", NULL, place, NULL, NULL, NULL, napi_default_method, NULL},
      {"rescore", NULL, rescore, NULL, NULL, NULL, napi_default_method, NULL},
      {"workspaceBytes", NULL, workspace_bytes, NULL, NULL, NULL, napi_default_method, NULL},
  };
  if (napi_define_properties(env, exports, sizeof properties / sizeof properties[0], properties) != napi_ok) {
    return throw_error(env, "the native search core cannot define its functions");
  }
  return exports;
}

extern NAPI_MODULE_EXPORT int32_t NODE_API_MODULE_GET_API_VERSION(void);

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialise)
