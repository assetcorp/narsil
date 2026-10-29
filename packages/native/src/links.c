#include "internal.h"

#include "../include/narsil_core.h"

#include <math.h>
#include <stdatomic.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

#define INITIAL_LIST_CAPACITY 256
#define FARTHEST_REJECTED_LINKS_KEPT 1U

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

uint32_t stored_count(const int32_t *list, uint32_t capacity) {
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
  if (position.layer == 0) { note_linked(context, neighbour); }
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
    if (position.layer == 0) { note_unlinked(context, neighbour); }
    return;
  }
}

void list_write_counted(const walk_context *context, node_layer position, const int32_t *neighbours, uint32_t count) {
  uint32_t capacity = 0;
  int32_t *list = list_at(context, position, &capacity);
  if (list == NULL) { return; }
  if (position.layer > 0) {
    list_replace(context, position, neighbours, count);
    return;
  }
  held_links held = {list + 1, stored_count(list, capacity), 0};
  held_links written = {neighbours, count > capacity ? capacity : count, 0};
  for (uint32_t i = 0; i < held.count; i++) {
    if (!list_holds(written, held.ordinals[i])) { note_unlinked(context, held.ordinals[i]); }
  }
  for (uint32_t i = 0; i < written.count; i++) {
    if (!list_holds(held, written.ordinals[i])) { note_linked(context, written.ordinals[i]); }
  }
  list_replace(context, position, neighbours, count);
}

void list_replace(const walk_context *context, node_layer position, const int32_t *neighbours, uint32_t count) {
  uint32_t capacity = 0;
  int32_t *list = list_at(context, position, &capacity);
  if (list == NULL) { return; }
  uint32_t kept = count > capacity ? capacity : count;
  for (uint32_t i = 0; i < kept; i++) { list[i + 1] = neighbours[i]; }
  list[0] = (int32_t)kept;
}

static uint32_t keep_farthest_rejected(const scored_list *sorted, uint32_t limit, int32_t *selected, uint32_t count) {
  if (count * 2 >= limit) { return count; }
  uint32_t kept = 0;
  for (uint32_t i = sorted->count; i > 0 && kept < FARTHEST_REJECTED_LINKS_KEPT; i--) {
    if (count >= limit) { return count; }
    int32_t candidate = sorted->ordinals[i - 1];
    held_links chosen = {selected, count, 0};
    if (list_holds(chosen, candidate)) { continue; }
    selected[count] = candidate;
    count += 1;
    kept += 1;
  }
  return count;
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
  return keep_farthest_rejected(candidates, limit, selected, count);
}

static int holds_its_last_link(const walk_context *context, int32_t layer, int32_t ordinal) {
  return layer == 0 && is_live(context, ordinal) && incoming_count(context, ordinal) <= 1;
}

static int lies_nearer_a_closer_link(const walk_context *context, const scored_list *sorted, uint32_t slot) {
  int32_t ordinal = sorted->ordinals[slot];
  for (uint32_t closer = 0; closer < slot; closer++) {
    if (pair_distance(context, ordinal, sorted->ordinals[closer]) < sorted->distances[slot]) { return 1; }
  }
  return 0;
}

static int release_layer_zero_link(const walk_context *context, int32_t ordinal) {
  if (!is_live(context, ordinal)) {
    note_unlinked(context, ordinal);
    return 1;
  }
  return release_unless_last(context, ordinal);
}

static uint32_t link_to_remove(const walk_context *context, const scored_list *sorted, int32_t layer) {
  for (uint32_t slot = sorted->count - 1; slot > 0; slot--) {
    if (holds_its_last_link(context, layer, sorted->ordinals[slot])) { continue; }
    if (!lies_nearer_a_closer_link(context, sorted, slot)) { continue; }
    if (layer > 0 || release_layer_zero_link(context, sorted->ordinals[slot])) { return slot; }
  }
  for (uint32_t slot = sorted->count - 1; slot > 0; slot--) {
    if (holds_its_last_link(context, layer, sorted->ordinals[slot])) { continue; }
    if (layer > 0 || release_layer_zero_link(context, sorted->ordinals[slot])) { return slot; }
  }
  uint32_t farthest = sorted->count - 1;
  if (layer == 0) {
    note_unlinked(context, sorted->ordinals[farthest]);
    note_node_left_unlinked(context);
  }
  return farthest;
}

static void remove_one_link(const walk_context *context, scored_list *sorted, int32_t layer) {
  uint32_t removed = link_to_remove(context, sorted, layer);
  for (uint32_t slot = removed; slot + 1 < sorted->count; slot++) {
    sorted->ordinals[slot] = sorted->ordinals[slot + 1];
    sorted->distances[slot] = sorted->distances[slot + 1];
  }
  sorted->count -= 1;
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
    if (distance == HUGE_VAL) {
      if (position.layer == 0) { note_unlinked(context, list[i]); }
      continue;
    }
    candidates->ordinals[candidates->count] = list[i];
    candidates->distances[candidates->count] = distance;
    candidates->count += 1;
  }
  list_sort_nearest_first(candidates);
  while (candidates->count > limit) { remove_one_link(context, candidates, position.layer); }
  list_replace(context, position, candidates->ordinals, candidates->count);
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
