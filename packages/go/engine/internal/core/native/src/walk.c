#include "internal.h"

#include "../include/narsil_core.h"

#include <math.h>
#include <stdatomic.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

static int lists_fit_the_workspace(const narsil_graph *graph) {
  int32_t max_neighbours = load_word(graph->header, NARSIL_GRAPH_WORD_M);
  int32_t max_base_neighbours = load_word(graph->header, NARSIL_GRAPH_WORD_MMAX0);
  if (max_neighbours <= 0 || max_base_neighbours <= 0) { return 0; }
  return max_neighbours < MAX_NEIGHBOURS_PER_LIST && max_base_neighbours < MAX_NEIGHBOURS_PER_LIST;
}

int graph_is_complete(const narsil_graph *graph) {
  return graph->header != NULL && graph->node_levels != NULL && graph->level0 != NULL && graph->upper_base != NULL &&
         graph->upper != NULL && graph->locks != NULL && graph->tombstones != NULL && graph->incoming != NULL &&
         graph->nearest_link_due != NULL && graph->held_locks != NULL;
}

static void begin_visit_round(narsil_workspace *workspace) {
  workspace->stamp += 1;
  if (workspace->stamp == UINT32_MAX) {
    memset(workspace->visited, 0, (size_t)workspace->visited_capacity * sizeof *workspace->visited);
    workspace->stamp = 1;
  }
}

static int claim_unvisited_node(const walk_context *context, int32_t ordinal) {
  narsil_workspace *workspace = context->workspace;
  if (ordinal < 0 || (uint32_t)ordinal >= context->slots || workspace->visited[ordinal] == workspace->stamp) {
    return 0;
  }
  workspace->visited[ordinal] = workspace->stamp;
  return node_top_layer(context, ordinal) >= 0;
}

static int accepts(narsil_ordinal_set accepted, int32_t ordinal) {
  if (accepted.bits == NULL) { return 1; }
  uint32_t index = (uint32_t)ordinal / BITS_PER_BYTE;
  if (index >= accepted.bytes) { return 0; }
  return (accepted.bits[index] & (1U << ((uint32_t)ordinal % BITS_PER_BYTE))) != 0;
}

static narsil_status keep_candidate(const walk_context *context, layer_search search, scored_node node,
                                    double *furthest) {
  narsil_workspace *workspace = context->workspace;
  narsil_status status = heap_push(&workspace->frontier, node);
  if (status != NARSIL_OK) { return status; }
  if (search.excludes_tombstones && is_tombstoned(context, node.ordinal)) { return NARSIL_OK; }
  if (!accepts(search.accepted, node.ordinal)) { return NARSIL_OK; }
  status = heap_push(&workspace->found, node);
  if (status != NARSIL_OK) { return status; }
  if (workspace->found.size > search.candidate_limit) { heap_pop(&workspace->found); }
  *furthest = workspace->found.distances[0];
  return NARSIL_OK;
}

static narsil_status seed_entry_points(const walk_context *context, layer_search search, double *furthest) {
  narsil_workspace *workspace = context->workspace;
  for (uint32_t i = 0; i < workspace->entry_point_count; i++) {
    int32_t entry = workspace->entry_points[i];
    if (!claim_unvisited_node(context, entry)) { continue; }
    double distance = walk_distance(context, entry);
    if (distance == HUGE_VAL) { continue; }
    scored_node node = {entry, distance};
    narsil_status status = keep_candidate(context, search, node, furthest);
    if (status != NARSIL_OK) { return status; }
  }
  return NARSIL_OK;
}

static narsil_status expand_node(const walk_context *context, layer_search search, double *furthest) {
  narsil_workspace *workspace = context->workspace;
  int32_t pending[MAX_NEIGHBOURS_PER_LIST];
  node_layer position = {workspace->frontier.top.ordinal, search.layer};
  uint32_t count = read_neighbours(context, position, workspace->neighbours);
  uint32_t pending_count = 0;
  for (uint32_t i = 0; i < count; i++) {
    int32_t neighbour = workspace->neighbours[i];
    if (!claim_unvisited_node(context, neighbour)) { continue; }
    pending[pending_count] = neighbour;
    pending_count += 1;
    prefetch_for_walk(context, neighbour);
  }
  for (uint32_t i = 0; i < pending_count; i++) {
    double distance = walk_distance(context, pending[i]);
    if (distance == HUGE_VAL) { continue; }
    if (distance < *furthest || workspace->found.size < search.candidate_limit) {
      scored_node node = {pending[i], distance};
      narsil_status status = keep_candidate(context, search, node, furthest);
      if (status != NARSIL_OK) { return status; }
    }
  }
  return NARSIL_OK;
}

static narsil_status drain_found(distance_heap *found, narsil_candidates *out) {
  uint32_t size = found->size;
  if (size > out->capacity) { return NARSIL_INVALID_ARGUMENT; }
  out->count = size;
  for (uint32_t i = size; i > 0; i--) {
    heap_pop(found);
    out->ordinals[i - 1] = found->top.ordinal;
    out->distances[i - 1] = found->top.distance;
  }
  return NARSIL_OK;
}

narsil_status search_layer(const walk_context *context, layer_search search, narsil_candidates *out) {
  narsil_workspace *workspace = context->workspace;
  begin_visit_round(workspace);
  workspace->frontier.size = 0;
  workspace->found.size = 0;
  double furthest = HUGE_VAL;
  narsil_status status = seed_entry_points(context, search, &furthest);
  if (status != NARSIL_OK) { return status; }
  while (heap_pop(&workspace->frontier)) {
    if (workspace->frontier.top.distance > furthest && workspace->found.size >= search.candidate_limit) { break; }
    status = expand_node(context, search, &furthest);
    if (status != NARSIL_OK) { return status; }
  }
  return drain_found(&workspace->found, out);
}

static double centroid_dot_of(const narsil_store *store) {
  double centroid_dot = 0;
  for (uint32_t i = 0; i < store->dimension; i++) {
    centroid_dot += (double)store->centroid[i] * (double)store->centroid[i];
  }
  return centroid_dot;
}

narsil_status begin_walk(walk_context *context, narsil_workspace *workspace, const narsil_graph *graph,
                         const narsil_store *store, uint32_t metric) {
  if (workspace == NULL || graph == NULL || store == NULL) { return NARSIL_INVALID_ARGUMENT; }
  if (!graph_is_complete(graph) || !store_is_complete(store)) { return NARSIL_INVALID_ARGUMENT; }
  if (store->dimension == 0 || !is_metric(metric) || !is_code_width(store->bits)) { return NARSIL_INVALID_ARGUMENT; }
  if (!lists_fit_the_workspace(graph)) { return NARSIL_INVALID_ARGUMENT; }

  memset(context, 0, sizeof *context);
  context->graph = graph;
  context->store = store;
  context->workspace = workspace;
  context->metric = (narsil_metric)metric;
  context->fence = &workspace->fence;
  int holds_codes = store->bits != 0 && store->records_per_block > 0;
  int calibrated = holds_codes && load_word(store->header, NARSIL_STORE_WORD_CALIBRATED) == 1;
  context->pairs_use_codes = calibrated;
  context->uses_codes = calibrated && load_word(store->header, NARSIL_STORE_WORD_CODE_COUNT) > 0;
  if (holds_codes) {
    context->code_bytes = code_bytes_of(store->dimension, store->bits);
    context->record_bytes = context->code_bytes + NARSIL_OSQ_TRAILER_BYTES;
  }
  if (context->uses_codes || context->pairs_use_codes) { context->centroid_dot = centroid_dot_of(store); }
  return workspace_reserve_dimension(workspace, store->dimension);
}

void walk_with_query(walk_context *context, const float *vector) {
  context->query.values = vector;
  if (context->uses_codes) {
    prepare_code(context->workspace, context->store, context->metric, vector, &context->code);
    return;
  }
  context->query.magnitude = (double)kernel_magnitude(vector, context->store->dimension);
}

void walk_with_placement_query(walk_context *context, const float *vector) {
  if (!context->uses_codes) {
    walk_with_query(context, vector);
    return;
  }
  context->query.values = vector;
  const narsil_store *store = context->store;
  prepare_code_with_bits(context->workspace, store, context->metric, vector, placement_query_bits_of(store->bits),
                         &context->code);
}

narsil_status read_graph_extent(walk_context *context) {
  int32_t slots = load_word(context->graph->header, NARSIL_GRAPH_WORD_SLOTS);
  int32_t store_slots = load_word(context->store->header, NARSIL_STORE_WORD_SLOTS);
  context->slots = slots < 0 ? 0 : (uint32_t)slots;
  context->store_slots = store_slots < 0 ? 0 : (uint32_t)store_slots;
  return workspace_reserve_visited(context->workspace, context->slots);
}

void use_single_entry(narsil_workspace *workspace, int32_t ordinal) {
  workspace->entry_points[0] = ordinal;
  workspace->entry_point_count = 1;
}

narsil_status descend_layers(const walk_context *context, int32_t first, int32_t last, narsil_candidates *out) {
  for (int32_t layer = first; layer >= last; layer--) {
    layer_search search = {1, layer, 0, {NULL, 0}};
    narsil_status status = search_layer(context, search, out);
    if (status != NARSIL_OK) { return status; }
    if (out->count > 0) { use_single_entry(context->workspace, out->ordinals[0]); }
  }
  return NARSIL_OK;
}

narsil_status narsil_search(narsil_workspace *workspace, const narsil_graph *graph, const narsil_store *store,
                            const narsil_search_request *request, narsil_candidates *nearest) {
  if (request == NULL || request->query == NULL || nearest == NULL) { return NARSIL_INVALID_ARGUMENT; }
  if (request->candidate_count == 0 || nearest->capacity < request->candidate_count) { return NARSIL_INVALID_ARGUMENT; }
  walk_context context;
  narsil_status status = begin_walk(&context, workspace, graph, store, request->metric);
  if (status != NARSIL_OK) { return status; }
  if (request->thread_slot >= graph->thread_slots) { return NARSIL_INVALID_ARGUMENT; }
  context.thread_slot = request->thread_slot;
  walk_with_query(&context, request->query);
  nearest->count = 0;

  graph_lock_shared(graph, request->thread_slot);
  status = read_graph_extent(&context);
  int32_t entry = load_word(graph->header, NARSIL_GRAPH_WORD_ENTRY_POINT);
  if (status == NARSIL_OK && entry != NO_ENTRY_POINT) {
    status = workspace_reserve_entry_points(workspace, 1);
    if (status == NARSIL_OK) {
      use_single_entry(workspace, entry);
      status = descend_layers(&context, load_word(graph->header, NARSIL_GRAPH_WORD_TOP_LAYER), 1, nearest);
    }
    layer_search base = {request->candidate_count, 0, 1, request->accepted};
    if (status == NARSIL_OK) { status = search_layer(&context, base, nearest); }
  }
  graph_unlock_shared(graph, request->thread_slot);
  return status;
}
