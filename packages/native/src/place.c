#include "internal.h"

#include "../include/narsil_core.h"

#include <stdatomic.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

static int32_t capacity_word(const narsil_graph *graph, uint32_t word) {
  int32_t capacity = load_word(graph->header, word);
  return capacity < 0 ? 0 : capacity;
}

static narsil_status claim_upper_lists(const narsil_graph *graph, int32_t top_layer, int32_t *upper_base) {
  *upper_base = 0;
  if (top_layer < 1) { return NARSIL_OK; }
  int64_t words = (int64_t)top_layer * ((int64_t)list_limit(graph, 1) + NARSIL_LIST_WORDS_OVER_NEIGHBOURS);
  _Atomic(int32_t) *used = atomic_word(graph->header, NARSIL_GRAPH_WORD_UPPER_USED);
  for (;;) {
    int32_t offset = atomic_load(used);
    if (offset < 0 || (int64_t)offset + words > capacity_word(graph, NARSIL_GRAPH_WORD_UPPER_CAPACITY)) {
      return NARSIL_NEEDS_ROOM;
    }
    if (!atomic_compare_exchange_strong(used, &offset, (int32_t)(offset + words))) { continue; }
    memset(graph->upper + offset, 0, (size_t)words * sizeof(int32_t));
    *upper_base = offset + 1;
    return NARSIL_OK;
  }
}

static void raise_slots(const narsil_graph *graph, int32_t slots) {
  _Atomic(int32_t) *word = atomic_word(graph->header, NARSIL_GRAPH_WORD_SLOTS);
  int32_t seen = atomic_load(word);
  while (seen < slots && !atomic_compare_exchange_strong(word, &seen, slots)) {}
}

static narsil_status create_node(const narsil_graph *graph, const narsil_place_request *request) {
  int32_t ordinal = request->ordinal;
  if (ordinal >= capacity_word(graph, NARSIL_GRAPH_WORD_SLOT_CAPACITY)) { return NARSIL_NEEDS_ROOM; }
  if (atomic_load(atomic_byte(graph->node_levels, (uint32_t)ordinal)) != 0) { return NARSIL_INVALID_ARGUMENT; }
  int32_t upper_base = 0;
  narsil_status status = claim_upper_lists(graph, request->top_layer, &upper_base);
  if (status != NARSIL_OK) { return status; }

  _Atomic(uint8_t) *tombstone = atomic_byte(graph->tombstones, (uint32_t)ordinal);
  if (atomic_load(tombstone) == 1) {
    atomic_fetch_sub(atomic_word(graph->header, NARSIL_GRAPH_WORD_TOMBSTONE_COUNT), 1);
    atomic_store(tombstone, 0);
  }
  size_t base_stride = (size_t)list_limit(graph, 0) + NARSIL_LIST_WORDS_OVER_NEIGHBOURS;
  graph->upper_base[ordinal] = upper_base;
  graph->level0[(size_t)ordinal * base_stride] = 0;
  raise_slots(graph, ordinal + 1);
  atomic_store(atomic_byte(graph->node_levels, (uint32_t)ordinal), (uint8_t)(request->top_layer + 1));
  atomic_fetch_add(atomic_word(graph->header, NARSIL_GRAPH_WORD_NODE_COUNT), 1);
  return NARSIL_OK;
}

static void retire_unlinked_node(const narsil_graph *graph, int32_t ordinal) {
  uint8_t live = 0;
  if (atomic_compare_exchange_strong(atomic_byte(graph->tombstones, (uint32_t)ordinal), &live, 1)) {
    atomic_fetch_add(atomic_word(graph->header, NARSIL_GRAPH_WORD_TOMBSTONE_COUNT), 1);
  }
}

static int claim_entry_if_empty(const walk_context *context, const narsil_place_request *request) {
  int32_t *header = context->graph->header;
  if (load_word(header, NARSIL_GRAPH_WORD_ENTRY_POINT) != NO_ENTRY_POINT) { return 0; }
  entry_lock(context->graph);
  int claimed = load_word(header, NARSIL_GRAPH_WORD_ENTRY_POINT) == NO_ENTRY_POINT;
  if (claimed) {
    atomic_store(atomic_word(header, NARSIL_GRAPH_WORD_ENTRY_POINT), request->ordinal);
    atomic_store(atomic_word(header, NARSIL_GRAPH_WORD_TOP_LAYER), request->top_layer);
  }
  entry_unlock(context->graph);
  return claimed;
}

static void raise_entry(const walk_context *context, const narsil_place_request *request) {
  int32_t *header = context->graph->header;
  entry_lock(context->graph);
  if (request->top_layer > load_word(header, NARSIL_GRAPH_WORD_TOP_LAYER)) {
    atomic_store(atomic_word(header, NARSIL_GRAPH_WORD_ENTRY_POINT), request->ordinal);
    atomic_store(atomic_word(header, NARSIL_GRAPH_WORD_TOP_LAYER), request->top_layer);
  }
  entry_unlock(context->graph);
}

static int32_t *selection_of(const narsil_workspace *workspace, int32_t layer) {
  return workspace->selections + ((size_t)layer * workspace->selection_stride);
}

static narsil_status reserve_for_placement(const walk_context *context, const narsil_place_request *request) {
  narsil_workspace *workspace = context->workspace;
  int32_t ef_construction = load_word(context->graph->header, NARSIL_GRAPH_WORD_EF_CONSTRUCTION);
  if (ef_construction <= 0) { return NARSIL_INVALID_ARGUMENT; }
  if (request->ordinal >= capacity_word(context->graph, NARSIL_GRAPH_WORD_SLOT_CAPACITY)) { return NARSIL_NEEDS_ROOM; }
  narsil_status status = list_reserve(&workspace->layer_candidates, (uint32_t)ef_construction);
  if (status == NARSIL_OK) { status = list_reserve(&workspace->link_candidates, MAX_NEIGHBOURS_PER_LIST); }
  if (status == NARSIL_OK) { status = workspace_reserve_entry_points(workspace, (uint32_t)ef_construction); }
  if (status == NARSIL_OK) { status = workspace_reserve_visited(workspace, (uint32_t)request->ordinal + 1); }
  if (status != NARSIL_OK) { return status; }
  return workspace_reserve_links(workspace, context->graph, (uint32_t)request->top_layer + 1);
}

static narsil_status select_every_layer(const walk_context *context, const narsil_place_request *request,
                                        link_span span) {
  narsil_workspace *workspace = context->workspace;
  uint32_t ef_construction = (uint32_t)load_word(context->graph->header, NARSIL_GRAPH_WORD_EF_CONSTRUCTION);
  scored_list *found = &workspace->layer_candidates;
  if (ef_construction == 0 || ef_construction > found->capacity) { return NARSIL_INVALID_ARGUMENT; }
  narsil_candidates candidates = {found->ordinals, found->distances, found->capacity, 0};
  use_single_entry(workspace, load_word(context->graph->header, NARSIL_GRAPH_WORD_ENTRY_POINT));
  narsil_status status = descend_layers(context, span.graph_top, request->top_layer + 1, &candidates);
  for (int32_t layer = span.link_top; layer >= 0 && status == NARSIL_OK; layer--) {
    layer_search search = {ef_construction, layer};
    status = search_layer(context, search, &candidates);
    if (status != NARSIL_OK) { break; }
    if (candidates.count > 0) {
      memcpy(workspace->entry_points, candidates.ordinals, (size_t)candidates.count * sizeof(int32_t));
      workspace->entry_point_count = candidates.count;
    }
    found->count = candidates.count;
    workspace->selection_counts[layer] =
        select_neighbours(context, found, list_limit(context->graph, layer), selection_of(workspace, layer));
  }
  return status;
}

static void write_own_lists(const walk_context *context, const narsil_place_request *request, int32_t link_top) {
  const narsil_workspace *workspace = context->workspace;
  node_lock(context, request->ordinal);
  for (int32_t layer = link_top; layer >= 0; layer--) {
    node_layer position = {request->ordinal, layer};
    list_replace(context, position, selection_of(workspace, layer), workspace->selection_counts[layer]);
  }
  node_unlock(context, request->ordinal);
}

static void link_neighbours_back(const walk_context *context, const narsil_place_request *request, int32_t link_top) {
  const narsil_workspace *workspace = context->workspace;
  for (int32_t layer = link_top; layer >= 0; layer--) {
    const int32_t *selected = selection_of(workspace, layer);
    for (uint32_t i = 0; i < workspace->selection_counts[layer]; i++) {
      node_layer position = {selected[i], layer};
      if (layer > node_top_layer(context, selected[i])) { continue; }
      node_lock(context, selected[i]);
      list_add(context, position, request->ordinal);
      list_prune(context, position);
      node_unlock(context, selected[i]);
    }
  }
}

static narsil_status link_node(walk_context *context, const narsil_place_request *request) {
  link_span span = {load_word(context->graph->header, NARSIL_GRAPH_WORD_TOP_LAYER), 0};
  span.link_top = request->top_layer < span.graph_top ? request->top_layer : span.graph_top;
  if (span.link_top >= 0) {
    narsil_status status = select_every_layer(context, request, span);
    if (status != NARSIL_OK) { return status; }
    write_own_lists(context, request, span.link_top);
    link_neighbours_back(context, request, span.link_top);
  }
  if (request->top_layer > span.graph_top) { raise_entry(context, request); }
  return NARSIL_OK;
}

static narsil_status place_under_the_graph_lock(walk_context *context, const narsil_place_request *request) {
  narsil_status status = reserve_for_placement(context, request);
  if (status == NARSIL_OK) { status = create_node(context->graph, request); }
  if (status != NARSIL_OK) { return status; }
  status = read_graph_extent(context);
  if (status == NARSIL_OK && !claim_entry_if_empty(context, request)) { status = link_node(context, request); }
  if (status != NARSIL_OK) { retire_unlinked_node(context->graph, request->ordinal); }
  return status;
}

narsil_status narsil_place(narsil_workspace *workspace, const narsil_graph *graph, const narsil_store *store,
                           const narsil_place_request *request) {
  if (request == NULL || request->ordinal < 0) { return NARSIL_INVALID_ARGUMENT; }
  if (request->top_layer < 0 || request->top_layer >= NARSIL_MAX_PLACEMENT_LAYERS) { return NARSIL_INVALID_ARGUMENT; }
  walk_context context;
  narsil_status status = begin_walk(&context, workspace, graph, store, request->metric);
  if (status != NARSIL_OK) { return status; }
  if (request->thread_slot >= graph->thread_slots) { return NARSIL_INVALID_ARGUMENT; }
  const float *vector = stored_vector(store, request->ordinal, workspace->placed_vector);
  if (vector == NULL) { return NARSIL_INVALID_ARGUMENT; }
  context.thread_slot = request->thread_slot;
  context.skip_tombstones = 0;
  walk_with_query(&context, vector);
  if (!context.uses_codes) { context.query.magnitude = store->magnitudes[request->ordinal]; }

  if (request->graph_held_alone) {
    if (load_word(graph->header, NARSIL_GRAPH_WORD_LOCK) != NARSIL_GRAPH_HELD_ALONE) {
      return NARSIL_GRAPH_NOT_HELD_ALONE;
    }
    return place_under_the_graph_lock(&context, request);
  }
  graph_lock_shared(graph, request->thread_slot);
  status = place_under_the_graph_lock(&context, request);
  graph_unlock_shared(graph, request->thread_slot);
  return status;
}
