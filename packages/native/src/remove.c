#include "internal.h"

#include "../include/narsil_core.h"

#include <math.h>
#include <stdatomic.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

static int is_tombstoned(const walk_context *context, int32_t ordinal) {
  return atomic_load(atomic_byte(context->graph->tombstones, (uint32_t)ordinal)) == 1;
}

static void begin_graph_write(walk_context *context, const narsil_graph *graph, uint32_t thread_slot) {
  memset(context, 0, sizeof *context);
  context->graph = graph;
  context->thread_slot = thread_slot;
  int32_t slots = load_word(graph->header, NARSIL_GRAPH_WORD_SLOTS);
  context->slots = slots < 0 ? 0 : (uint32_t)slots;
}

static void move_entry_off(const walk_context *context, int32_t ordinal) {
  if (load_word(context->graph->header, NARSIL_GRAPH_WORD_ENTRY_POINT) != ordinal) { return; }
  entry_lock(context->graph);
  if (load_word(context->graph->header, NARSIL_GRAPH_WORD_ENTRY_POINT) == ordinal) {
    store_entry_point(context, highest_node(context, 0));
  }
  entry_unlock(context->graph);
}

narsil_status narsil_remove(const narsil_graph *graph, const narsil_remove_request *request) {
  if (graph == NULL || request == NULL || !graph_is_complete(graph) || request->thread_slot >= graph->thread_slots) {
    return NARSIL_INVALID_ARGUMENT;
  }
  int32_t ordinal = request->ordinal;
  graph_lock_shared(graph, request->thread_slot);
  walk_context context;
  begin_graph_write(&context, graph, request->thread_slot);
  narsil_status status = NARSIL_OK;
  if (ordinal < 0 || (uint32_t)ordinal >= context.slots) {
    status = NARSIL_INVALID_ARGUMENT;
  } else if (node_top_layer(&context, ordinal) >= 0) {
    uint8_t live = 0;
    if (atomic_compare_exchange_strong(atomic_byte(graph->tombstones, (uint32_t)ordinal), &live, 1)) {
      atomic_fetch_add(atomic_word(graph->header, NARSIL_GRAPH_WORD_TOMBSTONE_COUNT), 1);
    }
    move_entry_off(&context, ordinal);
  }
  graph_unlock_shared(graph, request->thread_slot);
  return status;
}

static uint32_t copy_list(const walk_context *context, node_layer position, int32_t *out) {
  uint32_t capacity = 0;
  const int32_t *list = list_at(context, position, &capacity);
  if (list == NULL || list[0] < 0) { return 0; }
  uint32_t count = (uint32_t)list[0] > capacity ? capacity : (uint32_t)list[0];
  memcpy(out, list + 1, (size_t)count * sizeof *out);
  return count;
}

static void offer(const walk_context *context, int32_t node, int32_t candidate) {
  scored_list *candidates = &context->workspace->repair_candidates;
  for (uint32_t i = 0; i < candidates->count; i++) {
    if (candidates->ordinals[i] == candidate) { return; }
  }
  candidates->ordinals[candidates->count] = candidate;
  candidates->distances[candidates->count] = pair_distance(context, node, candidate);
  candidates->count += 1;
}

static void drop_unreachable_candidates(scored_list *candidates) {
  uint32_t kept = 0;
  for (uint32_t i = 0; i < candidates->count; i++) {
    if (candidates->distances[i] == HUGE_VAL) { continue; }
    candidates->ordinals[kept] = candidates->ordinals[i];
    candidates->distances[kept] = candidates->distances[i];
    kept += 1;
  }
  candidates->count = kept;
}

static int leaves_with_this_compaction(const walk_context *context, int32_t ordinal) {
  return node_top_layer(context, ordinal) < 0 || is_tombstoned(context, ordinal);
}

static void gather_repair_candidates(const walk_context *context, node_layer position, removed_node removed) {
  narsil_workspace *workspace = context->workspace;
  workspace->repair_candidates.count = 0;
  uint32_t held = copy_list(context, position, workspace->neighbours);
  for (uint32_t i = 0; i < held; i++) { offer(context, position.ordinal, workspace->neighbours[i]); }
  for (uint32_t i = 0; i < removed.former_count; i++) {
    int32_t other = workspace->former[i];
    if (other == position.ordinal || other == removed.ordinal || leaves_with_this_compaction(context, other)) {
      continue;
    }
    offer(context, position.ordinal, other);
  }
  drop_unreachable_candidates(&workspace->repair_candidates);
}

static void relink(const walk_context *context, node_layer position, uint32_t selected) {
  const narsil_workspace *workspace = context->workspace;
  for (uint32_t i = 0; i < selected; i++) {
    node_layer other = {workspace->repaired[i], position.layer};
    if (position.layer > node_top_layer(context, other.ordinal)) { continue; }
    node_lock(context, other.ordinal);
    list_add(context, other, position.ordinal);
    list_prune(context, other);
    node_unlock(context, other.ordinal);
  }
}

static void repair_neighbour(const walk_context *context, node_layer position, removed_node removed) {
  narsil_workspace *workspace = context->workspace;
  uint32_t limit = list_limit(context->graph, position.layer);
  uint32_t capacity = 0;
  const int32_t *list = list_at(context, position, &capacity);
  if (list == NULL || list[0] >= (int32_t)limit) { return; }
  gather_repair_candidates(context, position, removed);
  uint32_t selected = select_neighbours(context, &workspace->repair_candidates, limit, workspace->repaired);
  node_lock(context, position.ordinal);
  list_replace(context, position, workspace->repaired, selected);
  node_unlock(context, position.ordinal);
  relink(context, position, selected);
}

static void unlink_layer(const walk_context *context, node_layer layer_of_the_removed) {
  narsil_workspace *workspace = context->workspace;
  int32_t layer = layer_of_the_removed.layer;
  removed_node removed = {layer_of_the_removed.ordinal, copy_list(context, layer_of_the_removed, workspace->former)};
  for (uint32_t i = 0; i < removed.former_count; i++) {
    node_layer position = {workspace->former[i], layer};
    if (layer > node_top_layer(context, position.ordinal)) { continue; }
    node_lock(context, position.ordinal);
    list_take_out(context, position, removed.ordinal);
    node_unlock(context, position.ordinal);
  }
  for (uint32_t i = 0; i < removed.former_count; i++) {
    node_layer position = {workspace->former[i], layer};
    if (layer > node_top_layer(context, position.ordinal)) { continue; }
    repair_neighbour(context, position, removed);
  }
}

static void move_entry_after_removal(const walk_context *context, int32_t removed) {
  if (load_word(context->graph->header, NARSIL_GRAPH_WORD_ENTRY_POINT) != removed) { return; }
  entry_lock(context->graph);
  int32_t next = NO_NODE;
  if (load_word(context->graph->header, NARSIL_GRAPH_WORD_NODE_COUNT) > 0) {
    next = highest_node(context, 0);
    if (next == NO_NODE) { next = highest_node(context, 1); }
  }
  store_entry_point(context, next);
  entry_unlock(context->graph);
}

static void take_node_out(const walk_context *context, int32_t ordinal) {
  const narsil_graph *graph = context->graph;
  int32_t top_layer = node_top_layer(context, ordinal);
  for (int32_t layer = 0; layer <= top_layer; layer++) {
    node_layer removed = {ordinal, layer};
    unlink_layer(context, removed);
  }
  node_lock(context, ordinal);
  atomic_store(atomic_byte(graph->node_levels, (uint32_t)ordinal), 0);
  graph->upper_base[ordinal] = 0;
  graph->level0[(size_t)ordinal * ((size_t)list_limit(graph, 0) + NARSIL_LIST_WORDS_OVER_NEIGHBOURS)] = 0;
  node_unlock(context, ordinal);
  atomic_fetch_sub(atomic_word(graph->header, NARSIL_GRAPH_WORD_NODE_COUNT), 1);
  uint8_t tombstoned = 1;
  if (atomic_compare_exchange_strong(atomic_byte(graph->tombstones, (uint32_t)ordinal), &tombstoned, 0)) {
    atomic_fetch_sub(atomic_word(graph->header, NARSIL_GRAPH_WORD_TOMBSTONE_COUNT), 1);
  }
  move_entry_after_removal(context, ordinal);
}

narsil_status narsil_compact(narsil_workspace *workspace, const narsil_graph *graph, const narsil_store *store,
                             const narsil_compact_request *request) {
  if (request == NULL) { return NARSIL_INVALID_ARGUMENT; }
  walk_context context;
  narsil_status status = begin_walk(&context, workspace, graph, store, request->metric);
  if (status != NARSIL_OK) { return status; }
  if (request->thread_slot >= graph->thread_slots) { return NARSIL_INVALID_ARGUMENT; }
  if (load_word(graph->header, NARSIL_GRAPH_WORD_LOCK) != NARSIL_GRAPH_HELD_ALONE) {
    return NARSIL_GRAPH_NOT_HELD_ALONE;
  }
  context.thread_slot = request->thread_slot;
  status = read_graph_extent(&context);
  if (status == NARSIL_OK) { status = list_reserve(&workspace->repair_candidates, 2 * MAX_NEIGHBOURS_PER_LIST); }
  if (status == NARSIL_OK) { status = list_reserve(&workspace->link_candidates, MAX_NEIGHBOURS_PER_LIST); }
  if (status != NARSIL_OK) { return status; }
  if (load_word(graph->header, NARSIL_GRAPH_WORD_TOMBSTONE_COUNT) == 0) { return NARSIL_OK; }
  for (uint32_t ordinal = 0; ordinal < context.slots; ordinal++) {
    if (node_top_layer(&context, (int32_t)ordinal) < 0 || !is_tombstoned(&context, (int32_t)ordinal)) { continue; }
    take_node_out(&context, (int32_t)ordinal);
  }
  return NARSIL_OK;
}
