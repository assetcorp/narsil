#include "internal.h"

#include "../include/narsil_core.h"

#include <stdatomic.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

static _Atomic(int32_t) *incoming_word(const walk_context *context, int32_t ordinal) {
  if (ordinal < 0 || context->graph->incoming == NULL) { return NULL; }
  if (ordinal >= load_word(context->graph->header, NARSIL_GRAPH_WORD_SLOT_CAPACITY)) { return NULL; }
  return atomic_word(context->graph->incoming, (uint32_t)ordinal);
}

int32_t incoming_count(const walk_context *context, int32_t ordinal) {
  _Atomic(int32_t) *word = incoming_word(context, ordinal);
  return word == NULL ? 0 : atomic_load(word);
}

void note_linked(const walk_context *context, int32_t ordinal) {
  _Atomic(int32_t) *word = incoming_word(context, ordinal);
  if (word != NULL) { atomic_fetch_add(word, 1); }
}

void note_unlinked(const walk_context *context, int32_t ordinal) {
  _Atomic(int32_t) *word = incoming_word(context, ordinal);
  if (word == NULL) { return; }
  int32_t seen = atomic_load(word);
  while (seen > 0 && !atomic_compare_exchange_weak(word, &seen, seen - 1)) {}
}

void note_node_left_unlinked(const walk_context *context) {
  atomic_store(atomic_word(context->graph->header, NARSIL_GRAPH_WORD_UNLINKED_NODES), 1);
}

int release_unless_last(const walk_context *context, int32_t ordinal) {
  _Atomic(int32_t) *word = incoming_word(context, ordinal);
  if (word == NULL) { return 1; }
  int32_t seen = atomic_load(word);
  while (seen > 1) {
    if (atomic_compare_exchange_weak(word, &seen, seen - 1)) { return 1; }
  }
  return 0;
}

int is_live(const walk_context *context, int32_t ordinal) {
  return node_top_layer(context, ordinal) >= 0 && !is_tombstoned(context, ordinal);
}

narsil_status reserve_last_links(narsil_workspace *workspace) {
  return list_reserve(&workspace->dropped_links, MAX_REPAIR_CANDIDATES);
}

int list_holds(held_links list, int32_t ordinal) {
  for (uint32_t i = 0; i < list.count; i++) {
    if (list.ordinals[i] == ordinal) { return 1; }
  }
  return 0;
}

static int was_held(held_links held, int32_t ordinal) { return held.every_candidate || list_holds(held, ordinal); }

static double distance_in(const scored_list *sorted, int32_t ordinal) {
  for (uint32_t i = 0; i < sorted->count; i++) {
    if (sorted->ordinals[i] == ordinal) { return sorted->distances[i]; }
  }
  return 0;
}

static void collect_dropped(const scored_list *sorted, const int32_t *kept, uint32_t kept_count, scored_list *dropped) {
  dropped->count = 0;
  held_links chosen = {kept, kept_count, 0};
  for (uint32_t i = 0; i < sorted->count && dropped->count < dropped->capacity; i++) {
    if (list_holds(chosen, sorted->ordinals[i])) { continue; }
    dropped->ordinals[dropped->count] = sorted->ordinals[i];
    dropped->distances[dropped->count] = sorted->distances[i];
    dropped->count += 1;
  }
}

static int replace_farthest_shared(const walk_context *context, int32_t *kept, uint32_t kept_count, held_links held,
                                   scored_node replacement) {
  narsil_workspace *workspace = context->workspace;
  double *distances = workspace->kept_distances;
  uint8_t *tried = workspace->replacement_tried;
  memset(tried, 0, kept_count);
  for (;;) {
    int64_t farthest = -1;
    for (uint32_t k = 0; k < kept_count; k++) {
      if (tried[k] || incoming_count(context, kept[k]) < 2) { continue; }
      if (farthest == -1 || distances[k] > distances[farthest]) { farthest = k; }
    }
    if (farthest == -1) { return 0; }
    tried[farthest] = 1;
    int32_t replaced = kept[farthest];
    if (was_held(held, replaced) && !release_unless_last(context, replaced)) { continue; }
    kept[farthest] = replacement.ordinal;
    distances[farthest] = replacement.distance;
    return 1;
  }
}

uint32_t write_keeping_last_links(const walk_context *context, int32_t ordinal, const scored_list *sorted,
                                  int32_t *kept, uint32_t kept_count, held_links held) {
  narsil_workspace *workspace = context->workspace;
  uint32_t limit = list_limit(context->graph, 0);
  scored_list *dropped = &workspace->dropped_links;
  collect_dropped(sorted, kept, kept_count, dropped);
  for (uint32_t k = 0; k < kept_count; k++) { workspace->kept_distances[k] = distance_in(sorted, kept[k]); }
  uint32_t count = kept_count;
  for (uint32_t i = 0; i < dropped->count; i++) {
    int32_t candidate = dropped->ordinals[i];
    if (!was_held(held, candidate)) { continue; }
    if (!is_live(context, candidate)) {
      note_unlinked(context, candidate);
      continue;
    }
    if (release_unless_last(context, candidate)) { continue; }
    if (count < limit && count < MAX_NEIGHBOURS_PER_LIST) {
      kept[count] = candidate;
      workspace->kept_distances[count] = dropped->distances[i];
      count += 1;
      continue;
    }
    scored_node replacement = {candidate, dropped->distances[i]};
    if (replace_farthest_shared(context, kept, count, held, replacement)) { continue; }
    note_unlinked(context, candidate);
    note_node_left_unlinked(context);
  }
  for (uint32_t k = 0; k < count; k++) {
    if (!was_held(held, kept[k])) { note_linked(context, kept[k]); }
  }
  node_layer position = {ordinal, 0};
  list_replace(context, position, kept, count);
  return count;
}
