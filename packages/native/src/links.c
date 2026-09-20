#include "internal.h"

#include "../include/narsil_core.h"

#include <math.h>
#include <stdatomic.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

#define INITIAL_LIST_CAPACITY 256

narsil_status list_reserve(scored_list *list, uint32_t capacity) {
  if (capacity <= list->capacity) { return NARSIL_OK; }
  uint32_t held = list->capacity == 0 ? INITIAL_LIST_CAPACITY : list->capacity;
  uint32_t next = grown_capacity(held, capacity);
  int32_t *ordinals = realloc(list->ordinals, (size_t)next * sizeof *ordinals);
  if (ordinals == NULL) { return NARSIL_OUT_OF_MEMORY; }
  list->ordinals = ordinals;
  double *distances = realloc(list->distances, (size_t)next * sizeof *distances);
  if (distances == NULL) { return NARSIL_OUT_OF_MEMORY; }
  list->distances = distances;
  list->capacity = next;
  return NARSIL_OK;
}

void list_release(scored_list *list) {
  free(list->ordinals);
  free(list->distances);
  list->ordinals = NULL;
  list->distances = NULL;
  list->capacity = 0;
  list->count = 0;
}

void list_sort_nearest_first(scored_list *list) {
  for (uint32_t i = 1; i < list->count; i++) {
    int32_t ordinal = list->ordinals[i];
    double distance = list->distances[i];
    uint32_t slot = i;
    while (slot > 0 && list->distances[slot - 1] > distance) {
      list->distances[slot] = list->distances[slot - 1];
      list->ordinals[slot] = list->ordinals[slot - 1];
      slot -= 1;
    }
    list->distances[slot] = distance;
    list->ordinals[slot] = ordinal;
  }
}

static uint32_t stored_count(const int32_t *list, uint32_t capacity) {
  if (list[0] < 0) { return 0; }
  return (uint32_t)list[0] > capacity ? capacity : (uint32_t)list[0];
}

void list_add(const walk_context *context, node_layer position, int32_t neighbour) {
  uint32_t capacity = 0;
  int32_t *list = list_at(context, position, &capacity);
  if (list == NULL) { return; }
  uint32_t count = stored_count(list, capacity);
  for (uint32_t i = 1; i <= count; i++) {
    if (list[i] == neighbour) { return; }
  }
  if (count + 1 > capacity) { return; }
  list[count + 1] = neighbour;
  list[0] = (int32_t)(count + 1);
}

void list_take_out(const walk_context *context, node_layer position, int32_t neighbour) {
  uint32_t capacity = 0;
  int32_t *list = list_at(context, position, &capacity);
  if (list == NULL) { return; }
  uint32_t count = stored_count(list, capacity);
  for (uint32_t i = 1; i <= count; i++) {
    if (list[i] != neighbour) { continue; }
    for (uint32_t moved = i; moved < count; moved++) { list[moved] = list[moved + 1]; }
    list[0] = (int32_t)(count - 1);
    return;
  }
}

void list_replace(const walk_context *context, node_layer position, const int32_t *neighbours, uint32_t count) {
  uint32_t capacity = 0;
  int32_t *list = list_at(context, position, &capacity);
  if (list == NULL) { return; }
  uint32_t kept = count > capacity ? capacity : count;
  for (uint32_t i = 0; i < kept; i++) { list[i + 1] = neighbours[i]; }
  list[0] = (int32_t)kept;
}

uint32_t select_neighbours(const walk_context *context, scored_list *candidates, uint32_t limit, int32_t *selected) {
  list_sort_nearest_first(candidates);
  uint32_t count = 0;
  for (uint32_t i = 0; i < candidates->count && count < limit; i++) {
    int32_t candidate = candidates->ordinals[i];
    double distance = candidates->distances[i];
    int accepted = 1;
    for (uint32_t chosen = 0; chosen < count && accepted; chosen++) {
      if (distance >= pair_distance(context, candidate, selected[chosen])) { accepted = 0; }
    }
    if (!accepted) { continue; }
    selected[count] = candidate;
    count += 1;
  }
  return count;
}

void list_prune(const walk_context *context, node_layer position) {
  uint32_t capacity = 0;
  int32_t *list = list_at(context, position, &capacity);
  if (list == NULL) { return; }
  uint32_t limit = list_limit(context->graph, position.layer);
  uint32_t count = stored_count(list, capacity);
  if (count <= limit) { return; }
  scored_list *candidates = &context->workspace->link_candidates;
  if (list_reserve(candidates, count) != NARSIL_OK) { return; }
  candidates->count = 0;
  for (uint32_t i = 1; i <= count; i++) {
    double distance = pair_distance(context, position.ordinal, list[i]);
    if (distance == HUGE_VAL) { continue; }
    candidates->ordinals[candidates->count] = list[i];
    candidates->distances[candidates->count] = distance;
    candidates->count += 1;
  }
  uint32_t kept = select_neighbours(context, candidates, limit, context->workspace->kept);
  list_replace(context, position, context->workspace->kept, kept);
}

int32_t highest_node(const walk_context *context, int include_tombstoned) {
  int32_t best = NO_NODE;
  int32_t best_layer = -1;
  for (uint32_t ordinal = 0; ordinal < context->slots; ordinal++) {
    int32_t level = node_top_layer(context, (int32_t)ordinal);
    if (level < 0) { continue; }
    if (!include_tombstoned && atomic_load(atomic_byte(context->graph->tombstones, ordinal)) == 1) { continue; }
    if (level > best_layer) {
      best_layer = level;
      best = (int32_t)ordinal;
    }
  }
  return best;
}

void store_entry_point(const walk_context *context, int32_t ordinal) {
  int32_t *header = context->graph->header;
  atomic_store(atomic_word(header, NARSIL_GRAPH_WORD_ENTRY_POINT), ordinal);
  atomic_store(atomic_word(header, NARSIL_GRAPH_WORD_TOP_LAYER),
               ordinal == NO_NODE ? -1 : node_top_layer(context, ordinal));
}
