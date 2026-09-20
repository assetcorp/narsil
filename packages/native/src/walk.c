#include "internal.h"

#include "../include/narsil_core.h"

#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#define NO_ENTRY_POINT (-1)

typedef struct {
  uint32_t candidate_limit;
  int32_t layer;
} layer_search;

static int is_code_width(uint32_t bits) {
  switch (bits) {
    case 0:
    case 1:
    case 2:
    case 4:
    case BITS_PER_BYTE:
      return 1;
    default:
      return 0;
  }
}

static int lists_fit_the_workspace(const narsil_graph *graph) {
  int32_t max_neighbours = load_word(graph->header, NARSIL_GRAPH_WORD_M);
  int32_t max_base_neighbours = load_word(graph->header, NARSIL_GRAPH_WORD_MMAX0);
  if (max_neighbours <= 0 || max_base_neighbours <= 0) { return 0; }
  return max_neighbours < MAX_NEIGHBOURS_PER_LIST && max_base_neighbours < MAX_NEIGHBOURS_PER_LIST;
}

static int graph_is_complete(const narsil_graph *graph) {
  return graph->header != NULL && graph->node_levels != NULL && graph->level0 != NULL && graph->upper_base != NULL &&
         graph->upper != NULL && graph->locks != NULL && graph->tombstones != NULL && graph->held_locks != NULL;
}

static void begin_visit_round(narsil_workspace *workspace) {
  workspace->stamp += 1;
  if (workspace->stamp == UINT32_MAX) {
    memset(workspace->visited, 0, (size_t)workspace->visited_capacity * sizeof *workspace->visited);
    workspace->stamp = 1;
  }
}

static int claim_unvisited_node(narsil_workspace *workspace, const walk_context *context, int32_t ordinal) {
  if (ordinal < 0 || (uint32_t)ordinal >= context->slots || workspace->visited[ordinal] == workspace->stamp) {
    return 0;
  }
  workspace->visited[ordinal] = workspace->stamp;
  if (context->graph->node_levels[ordinal] == 0) { return 0; }
  return !(context->skip_tombstones && context->graph->tombstones[ordinal] == 1);
}

static narsil_status keep_candidate(narsil_workspace *workspace, uint32_t candidate_limit, scored_node node,
                                    double *furthest) {
  narsil_status status = heap_push(&workspace->frontier, node);
  if (status != NARSIL_OK) { return status; }
  status = heap_push(&workspace->found, node);
  if (status != NARSIL_OK) { return status; }
  if (workspace->found.size > candidate_limit) { heap_pop(&workspace->found); }
  *furthest = workspace->found.distances[0];
  return NARSIL_OK;
}

static narsil_status seed_entry_points(narsil_workspace *workspace, const walk_context *context,
                                       uint32_t candidate_limit, double *furthest) {
  for (uint32_t i = 0; i < workspace->entry_point_count; i++) {
    int32_t entry = workspace->entry_points[i];
    if (!claim_unvisited_node(workspace, context, entry)) { continue; }
    double distance = walk_distance(context, entry);
    if (distance == HUGE_VAL) { continue; }
    scored_node node = {entry, distance};
    narsil_status status = keep_candidate(workspace, candidate_limit, node, furthest);
    if (status != NARSIL_OK) { return status; }
  }
  return NARSIL_OK;
}

static narsil_status expand_node(narsil_workspace *workspace, const walk_context *context, layer_search search,
                                 double *furthest) {
  int32_t pending[MAX_NEIGHBOURS_PER_LIST];
  node_layer position = {workspace->frontier.top.ordinal, search.layer};
  uint32_t count = read_neighbours(context, position, workspace->neighbours);
  uint32_t pending_count = 0;
  for (uint32_t i = 0; i < count; i++) {
    int32_t neighbour = workspace->neighbours[i];
    if (!claim_unvisited_node(workspace, context, neighbour)) { continue; }
    pending[pending_count] = neighbour;
    pending_count += 1;
    prefetch_for_walk(context, neighbour);
  }
  for (uint32_t i = 0; i < pending_count; i++) {
    double distance = walk_distance(context, pending[i]);
    if (distance == HUGE_VAL) { continue; }
    if (distance < *furthest || workspace->found.size < search.candidate_limit) {
      scored_node node = {pending[i], distance};
      narsil_status status = keep_candidate(workspace, search.candidate_limit, node, furthest);
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

static narsil_status search_layer(narsil_workspace *workspace, const walk_context *context, layer_search search,
                                  narsil_candidates *out) {
  begin_visit_round(workspace);
  workspace->frontier.size = 0;
  workspace->found.size = 0;
  double furthest = HUGE_VAL;
  narsil_status status = seed_entry_points(workspace, context, search.candidate_limit, &furthest);
  if (status != NARSIL_OK) { return status; }
  while (heap_pop(&workspace->frontier)) {
    if (workspace->frontier.top.distance > furthest) { break; }
    status = expand_node(workspace, context, search, &furthest);
    if (status != NARSIL_OK) { return status; }
  }
  return drain_found(&workspace->found, out);
}

static narsil_status begin_walk(narsil_workspace *workspace, walk_context *context, const narsil_graph *graph,
                                const narsil_store *store, uint32_t metric, const float *vector, uint32_t thread_slot) {
  if (workspace == NULL || graph == NULL || store == NULL) { return NARSIL_INVALID_ARGUMENT; }
  if (!graph_is_complete(graph) || !store_is_complete(store)) { return NARSIL_INVALID_ARGUMENT; }
  if (store->dimension == 0 || thread_slot >= graph->thread_slots) { return NARSIL_INVALID_ARGUMENT; }
  if (!is_metric(metric) || !is_code_width(store->bits)) { return NARSIL_INVALID_ARGUMENT; }
  if (!lists_fit_the_workspace(graph)) { return NARSIL_INVALID_ARGUMENT; }

  memset(context, 0, sizeof *context);
  context->graph = graph;
  context->store = store;
  context->metric = (narsil_metric)metric;
  context->fence = &workspace->fence;
  context->query.values = vector;
  context->uses_codes = store->bits != 0 && store->records_per_block > 0 &&
                        load_word(store->header, NARSIL_STORE_WORD_CALIBRATED) == 1 &&
                        load_word(store->header, NARSIL_STORE_WORD_CODE_COUNT) > 0;

  narsil_status status = workspace_reserve_dimension(workspace, store->dimension);
  if (status != NARSIL_OK) { return status; }
  if (context->uses_codes) {
    context->code_bytes = code_bytes_of(store->dimension, store->bits);
    context->record_bytes = context->code_bytes + NARSIL_OSQ_TRAILER_BYTES;
    double centroid_dot = 0;
    for (uint32_t i = 0; i < store->dimension; i++) {
      centroid_dot += (double)store->centroid[i] * (double)store->centroid[i];
    }
    context->centroid_dot = centroid_dot;
    prepare_code(workspace, store, context->metric, vector, &context->code);
  } else {
    context->query.magnitude = (double)kernel_magnitude(vector, store->dimension);
  }
  return NARSIL_OK;
}

static narsil_status read_graph_extent(narsil_workspace *workspace, walk_context *context) {
  int32_t slots = load_word(context->graph->header, NARSIL_GRAPH_WORD_SLOTS);
  int32_t upper_used = load_word(context->graph->header, NARSIL_GRAPH_WORD_UPPER_USED);
  int32_t store_slots = load_word(context->store->header, NARSIL_STORE_WORD_SLOTS);
  context->slots = slots < 0 ? 0 : (uint32_t)slots;
  context->upper_used = upper_used < 0 ? 0 : (uint32_t)upper_used;
  context->store_slots = store_slots < 0 ? 0 : (uint32_t)store_slots;
  return workspace_reserve_visited(workspace, context->slots);
}

static void use_single_entry(narsil_workspace *workspace, int32_t ordinal) {
  workspace->entry_points[0] = ordinal;
  workspace->entry_point_count = 1;
}

static narsil_status descend_layers(narsil_workspace *workspace, const walk_context *context, int32_t first,
                                    int32_t last, narsil_candidates *out) {
  for (int32_t layer = first; layer >= last; layer--) {
    layer_search search = {1, layer};
    narsil_status status = search_layer(workspace, context, search, out);
    if (status != NARSIL_OK) { return status; }
    if (out->count > 0) { use_single_entry(workspace, out->ordinals[0]); }
  }
  return NARSIL_OK;
}

narsil_status narsil_search(narsil_workspace *workspace, const narsil_graph *graph, const narsil_store *store,
                            const narsil_search_request *request, narsil_candidates *nearest) {
  if (request == NULL || request->query == NULL || nearest == NULL) { return NARSIL_INVALID_ARGUMENT; }
  if (request->candidate_count == 0 || nearest->capacity < request->candidate_count) { return NARSIL_INVALID_ARGUMENT; }
  walk_context context;
  narsil_status status =
      begin_walk(workspace, &context, graph, store, request->metric, request->query, request->thread_slot);
  if (status != NARSIL_OK) { return status; }
  context.skip_tombstones = 1;
  nearest->count = 0;

  graph_lock_shared(graph, request->thread_slot);
  status = read_graph_extent(workspace, &context);
  int32_t entry = load_word(graph->header, NARSIL_GRAPH_WORD_ENTRY_POINT);
  if (status == NARSIL_OK && entry != NO_ENTRY_POINT) {
    status = workspace_reserve_entry_points(workspace, 1);
    if (status == NARSIL_OK) {
      use_single_entry(workspace, entry);
      status = descend_layers(workspace, &context, load_word(graph->header, NARSIL_GRAPH_WORD_TOP_LAYER), 1, nearest);
    }
    layer_search base = {request->candidate_count, 0};
    if (status == NARSIL_OK) { status = search_layer(workspace, &context, base, nearest); }
  }
  graph_unlock_shared(graph, request->thread_slot);
  return status;
}

static narsil_status link_layers(narsil_workspace *workspace, const walk_context *context,
                                 const narsil_place_request *request, narsil_placement *placement) {
  const narsil_graph *graph = context->graph;
  int32_t graph_top = load_word(graph->header, NARSIL_GRAPH_WORD_TOP_LAYER);
  int32_t ef_construction = load_word(graph->header, NARSIL_GRAPH_WORD_EF_CONSTRUCTION);
  int32_t link_top = request->top_layer < graph_top ? request->top_layer : graph_top;
  placement->linked_top_layer = link_top;
  if (link_top < 0 || ef_construction <= 0) { return NARSIL_OK; }
  if ((uint32_t)link_top >= placement->layer_count) { return NARSIL_INVALID_ARGUMENT; }

  narsil_status status = workspace_reserve_entry_points(workspace, (uint32_t)ef_construction);
  if (status != NARSIL_OK) { return status; }
  use_single_entry(workspace, load_word(graph->header, NARSIL_GRAPH_WORD_ENTRY_POINT));

  narsil_candidates *descent = &placement->per_layer[link_top];
  status = descend_layers(workspace, context, graph_top, request->top_layer + 1, descent);
  if (status != NARSIL_OK) { return status; }
  for (int32_t layer = link_top; layer >= 0; layer--) {
    narsil_candidates *candidates = &placement->per_layer[layer];
    layer_search search = {(uint32_t)ef_construction, layer};
    status = search_layer(workspace, context, search, candidates);
    if (status != NARSIL_OK) { return status; }
    if (candidates->count == 0) { continue; }
    memcpy(workspace->entry_points, candidates->ordinals, (size_t)candidates->count * sizeof(int32_t));
    workspace->entry_point_count = candidates->count;
  }
  return NARSIL_OK;
}

narsil_status narsil_place(narsil_workspace *workspace, const narsil_graph *graph, const narsil_store *store,
                           const narsil_place_request *request, narsil_placement *placement) {
  if (request == NULL || request->vector == NULL || placement == NULL || placement->per_layer == NULL) {
    return NARSIL_INVALID_ARGUMENT;
  }
  if (request->top_layer < 0 || request->top_layer >= NARSIL_MAX_PLACEMENT_LAYERS) { return NARSIL_INVALID_ARGUMENT; }
  walk_context context;
  narsil_status status =
      begin_walk(workspace, &context, graph, store, request->metric, request->vector, request->thread_slot);
  if (status != NARSIL_OK) { return status; }
  context.skip_tombstones = 0;
  status = read_graph_extent(workspace, &context);
  if (status != NARSIL_OK) { return status; }
  int32_t own = request->own_ordinal;
  if (!context.uses_codes && own >= 0 && (uint32_t)own < context.store_slots) {
    context.query.magnitude = store->magnitudes[own];
  }
  return link_layers(workspace, &context, request, placement);
}
