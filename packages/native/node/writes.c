#include "writes.h"

#include "field.h"
#include "values.h"

#include "../include/narsil_core.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <stddef.h>
#include <stdint.h>

#define WAKE_COUNT_WORDS 1

enum {
  PLACE_GRAPH,
  PLACE_STORE,
  PLACE_METRIC,
  PLACE_ORDINAL,
  PLACE_TOP_LAYER,
  PLACE_GRAPH_HELD_ALONE,
  PLACE_THREAD_SLOT,
  PLACE_WAKES,
  PLACE_ARGUMENT_COUNT
};

enum { REMOVE_GRAPH, REMOVE_ORDINAL, REMOVE_THREAD_SLOT, REMOVE_WAKES, REMOVE_ARGUMENT_COUNT };

enum { COMPACT_GRAPH, COMPACT_STORE, COMPACT_METRIC, COMPACT_THREAD_SLOT, COMPACT_WAKES, COMPACT_ARGUMENT_COUNT };

enum {
  CONNECT_GRAPH,
  CONNECT_STORE,
  CONNECT_METRIC,
  CONNECT_NEARBY,
  CONNECT_THREAD_SLOT,
  CONNECT_WAKES,
  CONNECT_ARGUMENT_COUNT
};

enum { RECORDS_STORE, RECORDS_METRIC, RECORDS_ORDINALS, RECORDS_COUNT, RECORDS_ARGUMENT_COUNT };
enum { MEASURE_TOTALS = RECORDS_ARGUMENT_COUNT, MEASURE_ARGUMENT_COUNT };

#define MEASURE_TOTALS_PAST_DIMENSION 2

static int hand_over_wakes(napi_env env, napi_value target, attached_graph *attached) {
  void *data = NULL;
  size_t capacity = 0;
  pending_wakes *wakes = &attached->wakes;
  if (!typed_data(env, target, napi_int32_array, &data, &capacity) || capacity < WAKE_COUNT_WORDS) {
    wakes->count = 0;
    return 0;
  }
  int32_t *out = data;
  uint32_t kept = wakes->count;
  if (kept > capacity - WAKE_COUNT_WORDS) { kept = clamped_count(capacity - WAKE_COUNT_WORDS); }
  for (uint32_t i = 0; i < kept; i++) { out[i + WAKE_COUNT_WORDS] = wakes->ordinals[i]; }
  out[0] = (int32_t)kept;
  wakes->count = 0;
  return 1;
}

napi_value place(napi_env env, napi_callback_info info) {
  napi_value argv[PLACE_ARGUMENT_COUNT];
  if (!callback_arguments(env, info, PLACE_ARGUMENT_COUNT, argv)) {
    return throw_error(env, "place takes a graph, a store, and six more arguments");
  }
  attached_graph *graph = graph_of(env, argv[PLACE_GRAPH]);
  attached_store *store = store_of(env, argv[PLACE_STORE]);
  thread_state *state = thread_state_of(env);
  if (graph == NULL || store == NULL || state == NULL) {
    return throw_error(env, "place takes an attached graph and an attached store");
  }
  narsil_place_request request = {NARSIL_METRIC_COSINE, 0, 0, 0, 0};
  if (napi_get_value_uint32(env, argv[PLACE_METRIC], &request.metric) != napi_ok ||
      napi_get_value_int32(env, argv[PLACE_ORDINAL], &request.ordinal) != napi_ok ||
      napi_get_value_int32(env, argv[PLACE_TOP_LAYER], &request.top_layer) != napi_ok ||
      napi_get_value_uint32(env, argv[PLACE_GRAPH_HELD_ALONE], &request.graph_held_alone) != napi_ok ||
      napi_get_value_uint32(env, argv[PLACE_THREAD_SLOT], &request.thread_slot) != napi_ok) {
    return throw_error(env, "an argument to place has the wrong type");
  }
  graph->wakes.count = 0;
  narsil_status status = narsil_place(state->workspace, &graph->graph, &store->store, &request);
  report_workspace_memory(env, state);
  if (!hand_over_wakes(env, argv[PLACE_WAKES], graph)) {
    return throw_error(env, "place takes an Int32Array of wakes");
  }
  return status_of(env, status);
}

napi_value remove_node(napi_env env, napi_callback_info info) {
  napi_value argv[REMOVE_ARGUMENT_COUNT];
  attached_graph *graph =
      callback_arguments(env, info, REMOVE_ARGUMENT_COUNT, argv) ? graph_of(env, argv[REMOVE_GRAPH]) : NULL;
  if (graph == NULL) { return throw_error(env, "remove takes an attached graph and three more arguments"); }
  narsil_remove_request request = {0, 0};
  if (napi_get_value_int32(env, argv[REMOVE_ORDINAL], &request.ordinal) != napi_ok ||
      napi_get_value_uint32(env, argv[REMOVE_THREAD_SLOT], &request.thread_slot) != napi_ok) {
    return throw_error(env, "an argument to remove has the wrong type");
  }
  graph->wakes.count = 0;
  narsil_status status = narsil_remove(&graph->graph, &request);
  if (!hand_over_wakes(env, argv[REMOVE_WAKES], graph)) {
    return throw_error(env, "remove takes an Int32Array of wakes");
  }
  return status_of(env, status);
}

napi_value compact(napi_env env, napi_callback_info info) {
  napi_value argv[COMPACT_ARGUMENT_COUNT];
  if (!callback_arguments(env, info, COMPACT_ARGUMENT_COUNT, argv)) {
    return throw_error(env, "compact takes a graph, a store, and three more arguments");
  }
  attached_graph *graph = graph_of(env, argv[COMPACT_GRAPH]);
  attached_store *store = store_of(env, argv[COMPACT_STORE]);
  thread_state *state = thread_state_of(env);
  if (graph == NULL || store == NULL || state == NULL) {
    return throw_error(env, "compact takes an attached graph and an attached store");
  }
  narsil_compact_request request = {NARSIL_METRIC_COSINE, 0};
  if (napi_get_value_uint32(env, argv[COMPACT_METRIC], &request.metric) != napi_ok ||
      napi_get_value_uint32(env, argv[COMPACT_THREAD_SLOT], &request.thread_slot) != napi_ok) {
    return throw_error(env, "an argument to compact has the wrong type");
  }
  graph->wakes.count = 0;
  narsil_status status = narsil_compact(state->workspace, &graph->graph, &store->store, &request);
  report_workspace_memory(env, state);
  if (!hand_over_wakes(env, argv[COMPACT_WAKES], graph)) {
    return throw_error(env, "compact takes an Int32Array of wakes");
  }
  return status_of(env, status);
}

napi_value connect_unreached(napi_env env, napi_callback_info info) {
  napi_value argv[CONNECT_ARGUMENT_COUNT];
  if (!callback_arguments(env, info, CONNECT_ARGUMENT_COUNT, argv)) {
    return throw_error(env, "connectUnreached takes a graph, a store, and four more arguments");
  }
  attached_graph *graph = graph_of(env, argv[CONNECT_GRAPH]);
  attached_store *store = store_of(env, argv[CONNECT_STORE]);
  thread_state *state = thread_state_of(env);
  if (graph == NULL || store == NULL || state == NULL) {
    return throw_error(env, "connectUnreached takes an attached graph and an attached store");
  }
  void *nearby = NULL;
  size_t nearby_length = 0;
  narsil_connect_request request = {NARSIL_METRIC_COSINE, 0, NULL, 0};
  if (napi_get_value_uint32(env, argv[CONNECT_METRIC], &request.metric) != napi_ok ||
      !possibly_empty_typed_data(env, argv[CONNECT_NEARBY], napi_int32_array, &nearby, &nearby_length) ||
      napi_get_value_uint32(env, argv[CONNECT_THREAD_SLOT], &request.thread_slot) != napi_ok) {
    return throw_error(env, "an argument to connectUnreached has the wrong type");
  }
  request.nearby = nearby;
  request.nearby_count = clamped_count(nearby_length);
  graph->wakes.count = 0;
  narsil_status status = narsil_connect_unreached(state->workspace, &graph->graph, &store->store, &request);
  report_workspace_memory(env, state);
  if (!hand_over_wakes(env, argv[CONNECT_WAKES], graph)) {
    return throw_error(env, "connectUnreached takes an Int32Array of wakes");
  }
  return status_of(env, status);
}

static const char *read_records_request(napi_env env, const napi_value *argv, narsil_ordinals_request *request) {
  void *ordinals = NULL;
  size_t ordinal_length = 0;
  if (napi_get_value_uint32(env, argv[RECORDS_METRIC], &request->metric) != napi_ok ||
      !typed_data(env, argv[RECORDS_ORDINALS], napi_int32_array, &ordinals, &ordinal_length) ||
      napi_get_value_uint32(env, argv[RECORDS_COUNT], &request->count) != napi_ok) {
    return "an argument to the call has the wrong type";
  }
  if (request->count > ordinal_length) { return "the ordinals are fewer than the count"; }
  request->ordinals = ordinals;
  return NULL;
}

napi_value quantise(napi_env env, napi_callback_info info) {
  napi_value argv[RECORDS_ARGUMENT_COUNT];
  attached_store *store =
      callback_arguments(env, info, RECORDS_ARGUMENT_COUNT, argv) ? store_of(env, argv[RECORDS_STORE]) : NULL;
  thread_state *state = thread_state_of(env);
  if (store == NULL || state == NULL) {
    return throw_error(env, "quantise takes an attached store and three arguments");
  }
  narsil_ordinals_request request = {NARSIL_METRIC_COSINE, NULL, 0};
  const char *refusal = read_records_request(env, argv, &request);
  if (refusal != NULL) { return throw_error(env, refusal); }
  narsil_status status = narsil_quantise(state->workspace, &store->store, &request);
  report_workspace_memory(env, state);
  return status_of(env, status);
}

napi_value measure(napi_env env, napi_callback_info info) {
  napi_value argv[MEASURE_ARGUMENT_COUNT];
  attached_store *store =
      callback_arguments(env, info, MEASURE_ARGUMENT_COUNT, argv) ? store_of(env, argv[RECORDS_STORE]) : NULL;
  thread_state *state = thread_state_of(env);
  if (store == NULL || state == NULL) { return throw_error(env, "measure takes an attached store and four arguments"); }
  narsil_ordinals_request request = {NARSIL_METRIC_COSINE, NULL, 0};
  const char *refusal = read_records_request(env, argv, &request);
  if (refusal != NULL) { return throw_error(env, refusal); }
  void *totals = NULL;
  size_t total_length = 0;
  if (!typed_data(env, argv[MEASURE_TOTALS], napi_float64_array, &totals, &total_length) ||
      total_length < (size_t)store->store.dimension + MEASURE_TOTALS_PAST_DIMENSION) {
    return throw_error(env, "measure takes a Float64Array with two more totals than the store has dimensions");
  }
  narsil_status status = narsil_measure(state->workspace, &store->store, &request, totals);
  report_workspace_memory(env, state);
  return status_of(env, status);
}
