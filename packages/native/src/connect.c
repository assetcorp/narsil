#include "internal.h"

#include "../include/narsil_core.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

typedef struct {
  uint8_t *reached;
  int32_t *first_reached_through;
  int32_t *queue;
  uint32_t head;
  uint32_t tail;
} layer_walk;

typedef struct {
  int32_t from;
  int32_t to;
} base_link;

typedef struct {
  int32_t *list;
  uint32_t count;
  uint8_t *holds;
} nearby_nodes;

typedef int (*host_test)(const walk_context *context, const layer_walk *walk, int32_t host);

static int32_t *base_list(const walk_context *context, int32_t ordinal, uint32_t *count) {
  uint32_t capacity = 0;
  node_layer base = {ordinal, 0};
  int32_t *list = list_at(context, base, &capacity);
  *count = list == NULL ? 0 : stored_count(list, capacity);
  return list;
}

static void reach(layer_walk *walk, base_link arrival) {
  walk->reached[arrival.to] = 1;
  walk->first_reached_through[arrival.to] = arrival.from;
  walk->queue[walk->tail++] = arrival.to;
}

static void walk_from(const walk_context *context, layer_walk *walk, base_link arrival) {
  if (walk->reached[arrival.to] == 1) { return; }
  reach(walk, arrival);
  while (walk->head < walk->tail) {
    int32_t ordinal = walk->queue[walk->head++];
    uint32_t count = 0;
    const int32_t *list = base_list(context, ordinal, &count);
    for (uint32_t i = 1; i <= count; i++) {
      int32_t next = list[i];
      if (node_top_layer(context, next) < 0 || walk->reached[next] == 1) { continue; }
      base_link onward = {ordinal, next};
      reach(walk, onward);
    }
  }
}

static int has_room(const walk_context *context, const layer_walk *walk, int32_t host) {
  (void)walk;
  uint32_t count = 0;
  const int32_t *list = base_list(context, host, &count);
  return list != NULL && count < list_limit(context->graph, 0);
}

static int reached_through_another_node(const walk_context *context, const layer_walk *walk, base_link link) {
  if (link.to < 0 || (uint32_t)link.to >= context->slots || walk->reached[link.to] != 1) { return 0; }
  int32_t through = walk->first_reached_through[link.to];
  return through != NO_NODE && through != link.from;
}

static int holds_link_outside_the_walk(const walk_context *context, const layer_walk *walk, int32_t host) {
  uint32_t count = 0;
  const int32_t *list = base_list(context, host, &count);
  for (uint32_t i = 1; i <= count; i++) {
    base_link link = {host, list[i]};
    if (reached_through_another_node(context, walk, link)) { return 1; }
  }
  return 0;
}

typedef struct {
  int32_t ordinal;
  double distance;
} host_choice;

static void consider(const walk_context *context, const layer_walk *walk, int32_t orphan, int32_t host, host_test test,
                     host_choice *best) {
  if (host == orphan || walk->reached[host] != 1 || !is_live(context, host) || !test(context, walk, host)) { return; }
  double away = pair_distance(context, orphan, host);
  if (best->ordinal == NO_NODE || away < best->distance) {
    best->ordinal = host;
    best->distance = away;
  }
}

static int32_t nearest_host(const walk_context *context, const layer_walk *walk, int32_t orphan,
                            const nearby_nodes *nearby, host_test test) {
  host_choice best = {NO_NODE, 0};
  for (uint32_t i = 0; i < nearby->count; i++) { consider(context, walk, orphan, nearby->list[i], test, &best); }
  uint32_t count = 0;
  const int32_t *list = base_list(context, orphan, &count);
  for (uint32_t i = 1; i <= count; i++) {
    int32_t host = list[i];
    if (host < 0 || (uint32_t)host >= context->slots || nearby->holds[host] == 1) { continue; }
    consider(context, walk, orphan, host, test, &best);
  }
  if (best.ordinal != NO_NODE) { return best.ordinal; }
  for (uint32_t host = 0; host < context->slots; host++) {
    consider(context, walk, orphan, (int32_t)host, test, &best);
  }
  return best.ordinal;
}

static void take_out_farthest_link_outside_the_walk(const walk_context *context, const layer_walk *walk, int32_t host) {
  node_lock(context, host);
  uint32_t count = 0;
  int32_t *list = base_list(context, host, &count);
  uint32_t farthest = 0;
  double farthest_distance = 0;
  for (uint32_t i = 1; i <= count; i++) {
    base_link link = {host, list[i]};
    if (!reached_through_another_node(context, walk, link)) { continue; }
    double away = pair_distance(context, host, list[i]);
    if (farthest == 0 || away > farthest_distance) {
      farthest = i;
      farthest_distance = away;
    }
  }
  if (farthest != 0) {
    int32_t taken = list[farthest];
    for (uint32_t i = farthest; i < count; i++) { list[i] = list[i + 1]; }
    list[0] = (int32_t)(count - 1);
    note_unlinked(context, taken);
  }
  node_unlock(context, host);
}

static void append_to(const walk_context *context, node_layer host, int32_t orphan) {
  node_lock(context, host.ordinal);
  list_add(context, host, orphan);
  node_unlock(context, host.ordinal);
}

static void gather_nearby(const walk_context *context, const narsil_connect_request *request, nearby_nodes *nearby) {
  for (uint32_t i = 0; i < request->nearby_count; i++) {
    int32_t ordinal = request->nearby[i];
    if (ordinal < 0 || (uint32_t)ordinal >= context->slots || nearby->holds[ordinal] == 1) { continue; }
    nearby->holds[ordinal] = 1;
    nearby->list[nearby->count++] = ordinal;
  }
}

static void connect_every_unreached(const walk_context *context, layer_walk *walk, const nearby_nodes *nearby) {
  for (uint32_t ordinal = 0; ordinal < context->slots; ordinal++) {
    int32_t orphan = (int32_t)ordinal;
    if (walk->reached[orphan] == 1 || !is_live(context, orphan)) { continue; }
    int32_t host = nearest_host(context, walk, orphan, nearby, has_room);
    if (host == NO_NODE) {
      host = nearest_host(context, walk, orphan, nearby, holds_link_outside_the_walk);
      if (host == NO_NODE) { continue; }
      take_out_farthest_link_outside_the_walk(context, walk, host);
    }
    node_layer host_base = {host, 0};
    append_to(context, host_base, orphan);
    base_link arrival = {host, orphan};
    walk_from(context, walk, arrival);
  }
}

static narsil_status begin_connect(walk_context *context, narsil_workspace *workspace, const narsil_graph *graph,
                                   const narsil_store *store, const narsil_connect_request *request) {
  if (request == NULL || (request->nearby == NULL && request->nearby_count > 0)) { return NARSIL_INVALID_ARGUMENT; }
  narsil_status status = begin_walk(context, workspace, graph, store, request->metric);
  if (status != NARSIL_OK) { return status; }
  if (request->thread_slot >= graph->thread_slots) { return NARSIL_INVALID_ARGUMENT; }
  if (load_word(graph->header, NARSIL_GRAPH_WORD_LOCK) != NARSIL_GRAPH_HELD_ALONE) {
    return NARSIL_GRAPH_NOT_HELD_ALONE;
  }
  context->thread_slot = request->thread_slot;
  return read_graph_extent(context);
}

narsil_status narsil_connect_unreached(narsil_workspace *workspace, const narsil_graph *graph,
                                       const narsil_store *store, const narsil_connect_request *request) {
  walk_context context;
  narsil_status status = begin_connect(&context, workspace, graph, store, request);
  if (status != NARSIL_OK) { return status; }
  int32_t entry = load_word(graph->header, NARSIL_GRAPH_WORD_ENTRY_POINT);
  if (node_top_layer(&context, entry) < 0) { return NARSIL_OK; }
  size_t slots = context.slots;
  layer_walk walk = {calloc(slots, sizeof *walk.reached), calloc(slots, sizeof *walk.first_reached_through),
                     calloc(slots, sizeof *walk.queue), 0, 0};
  nearby_nodes nearby = {calloc((size_t)request->nearby_count + 1, sizeof *nearby.list), 0, calloc(slots, 1)};
  if (walk.reached != NULL && walk.first_reached_through != NULL && walk.queue != NULL && nearby.list != NULL &&
      nearby.holds != NULL) {
    base_link arrival = {NO_NODE, entry};
    walk_from(&context, &walk, arrival);
    gather_nearby(&context, request, &nearby);
    connect_every_unreached(&context, &walk, &nearby);
  } else {
    status = NARSIL_OUT_OF_MEMORY;
  }
  free(walk.reached);
  free(walk.first_reached_through);
  free(walk.queue);
  free(nearby.list);
  free(nearby.holds);
  return status;
}
