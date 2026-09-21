#include "values.h"

#include "field.h"
#include "host_api.h"
#include "writes.h"

#include "../include/narsil_core.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <node_api.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

enum { ATTACH_MEMORY, ATTACH_ARGUMENT_COUNT };

enum {
  SEARCH_GRAPH,
  SEARCH_STORE,
  SEARCH_QUERY,
  SEARCH_METRIC,
  SEARCH_CANDIDATE_COUNT,
  SEARCH_THREAD_SLOT,
  SEARCH_ORDINALS,
  SEARCH_DISTANCES,
  SEARCH_ARGUMENT_COUNT
};

enum { SCORE_STORE, SCORE_QUERY, SCORE_METRIC, SCORE_ORDINALS, SCORE_COUNT, SCORE_DISTANCES, SCORE_ARGUMENT_COUNT };

static napi_value attach_graph(napi_env env, napi_callback_info info) {
  napi_value argv[ATTACH_ARGUMENT_COUNT];
  if (!callback_arguments(env, info, ATTACH_ARGUMENT_COUNT, argv)) {
    return throw_error(env, "attachGraph takes the memory of one graph");
  }
  attached_graph *attached = read_graph(env, argv[ATTACH_MEMORY]);
  if (attached == NULL) { return throw_error(env, "the graph memory is invalid, or attachGraph cannot allocate"); }
  napi_value handle = NULL;
  if (napi_create_reference(env, argv[ATTACH_MEMORY], 1, &attached->memory) != napi_ok ||
      napi_create_external(env, attached, release_graph, NULL, &handle) != napi_ok) {
    release_graph(env, attached, NULL);
    return throw_error(env, "attachGraph cannot create the graph handle");
  }
  return handle;
}

static napi_value attach_store(napi_env env, napi_callback_info info) {
  napi_value argv[ATTACH_ARGUMENT_COUNT];
  if (!callback_arguments(env, info, ATTACH_ARGUMENT_COUNT, argv)) {
    return throw_error(env, "attachStore takes the memory of one store");
  }
  attached_store *attached = read_store(env, argv[ATTACH_MEMORY]);
  if (attached == NULL) { return throw_error(env, "the store memory is invalid, or attachStore cannot allocate"); }
  napi_value handle = NULL;
  if (napi_create_reference(env, argv[ATTACH_MEMORY], 1, &attached->memory) != napi_ok ||
      napi_create_external(env, attached, release_store, NULL, &handle) != napi_ok) {
    release_store(env, attached, NULL);
    return throw_error(env, "attachStore cannot create the store handle");
  }
  return handle;
}

static napi_value detach_store_handle(napi_env env, napi_callback_info info) {
  napi_value argv[ATTACH_ARGUMENT_COUNT];
  attached_store *attached =
      callback_arguments(env, info, ATTACH_ARGUMENT_COUNT, argv) ? store_of(env, argv[ATTACH_MEMORY]) : NULL;
  if (attached != NULL) { detach_store(attached); }
  return number_of(env, 0);
}

static napi_value search(napi_env env, napi_callback_info info) {
  napi_value argv[SEARCH_ARGUMENT_COUNT];
  if (!callback_arguments(env, info, SEARCH_ARGUMENT_COUNT, argv)) {
    return throw_error(env, "search takes a graph, a store, and six more arguments");
  }
  attached_graph *graph = graph_of(env, argv[SEARCH_GRAPH]);
  attached_store *store = store_of(env, argv[SEARCH_STORE]);
  thread_state *state = thread_state_of(env);
  if (graph == NULL || store == NULL || state == NULL) {
    return throw_error(env, "search takes an attached graph and an attached store");
  }
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
  if (query_length != store->store.dimension) { return throw_error(env, "the query has the wrong dimension"); }
  uint32_t capacity = clamped_count(ordinal_capacity < distance_capacity ? ordinal_capacity : distance_capacity);
  if (capacity < request.candidate_count) {
    return throw_error(env, "the result arrays hold fewer entries than the candidate count");
  }
  request.query = query;
  narsil_candidates nearest = {ordinals, distances, capacity, 0};
  narsil_status status = narsil_search(state->workspace, &graph->graph, &store->store, &request, &nearest);
  report_workspace_memory(env, state);
  if (status != NARSIL_OK) { return number_of(env, -(int32_t)status); }
  return number_of(env, (int32_t)nearest.count);
}

static napi_value score(napi_env env, napi_callback_info info) {
  napi_value argv[SCORE_ARGUMENT_COUNT];
  attached_store *store =
      callback_arguments(env, info, SCORE_ARGUMENT_COUNT, argv) ? store_of(env, argv[SCORE_STORE]) : NULL;
  thread_state *state = thread_state_of(env);
  if (store == NULL || state == NULL) { return throw_error(env, "score takes an attached store and five arguments"); }
  void *query = NULL;
  void *ordinals = NULL;
  void *distances = NULL;
  size_t query_length = 0;
  size_t ordinal_length = 0;
  size_t distance_length = 0;
  narsil_score_request request = {NULL, NARSIL_METRIC_COSINE, NULL, 0};
  if (!typed_data(env, argv[SCORE_QUERY], napi_float32_array, &query, &query_length) ||
      napi_get_value_uint32(env, argv[SCORE_METRIC], &request.metric) != napi_ok ||
      !typed_data(env, argv[SCORE_ORDINALS], napi_int32_array, &ordinals, &ordinal_length) ||
      napi_get_value_uint32(env, argv[SCORE_COUNT], &request.count) != napi_ok ||
      !typed_data(env, argv[SCORE_DISTANCES], napi_float64_array, &distances, &distance_length)) {
    return throw_error(env, "an argument to score has the wrong type");
  }
  if (query_length != store->store.dimension) { return throw_error(env, "the query has the wrong dimension"); }
  if (request.count > ordinal_length || request.count > distance_length) {
    return throw_error(env, "the arrays passed to score are shorter than the count");
  }
  request.query = query;
  request.ordinals = ordinals;
  narsil_status status = narsil_score(state->workspace, &store->store, &request, distances);
  report_workspace_memory(env, state);
  return status_of(env, status);
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
      {"attachGraph", NULL, attach_graph, NULL, NULL, NULL, napi_default_method, NULL},
      {"attachStore", NULL, attach_store, NULL, NULL, NULL, napi_default_method, NULL},
      {"detachStore", NULL, detach_store_handle, NULL, NULL, NULL, napi_default_method, NULL},
      {"search", NULL, search, NULL, NULL, NULL, napi_default_method, NULL},
      {"score", NULL, score, NULL, NULL, NULL, napi_default_method, NULL},
      {"place", NULL, place, NULL, NULL, NULL, napi_default_method, NULL},
      {"remove", NULL, remove_node, NULL, NULL, NULL, napi_default_method, NULL},
      {"compact", NULL, compact, NULL, NULL, NULL, napi_default_method, NULL},
      {"calibrate", NULL, calibrate, NULL, NULL, NULL, napi_default_method, NULL},
      {"quantise", NULL, quantise, NULL, NULL, NULL, napi_default_method, NULL},
      {"workspaceBytes", NULL, workspace_bytes, NULL, NULL, NULL, napi_default_method, NULL},
  };
  if (napi_define_properties(env, exports, sizeof properties / sizeof properties[0], properties) != napi_ok) {
    return throw_error(env, "the native search core cannot define its functions");
  }
  return exports;
}

extern NAPI_MODULE_EXPORT int32_t NODE_API_MODULE_GET_API_VERSION(void);

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialise)
