#include "internal.h"

#include "../include/narsil_core.h"

#include <stdatomic.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

#define NEAREST_LINK_FALLBACK_HOSTS 4U
#define NEAREST_NOT_YET_FOUND (-2)

typedef struct {
  const walk_context *context;
  int32_t *nearest;
} nearest_pass;

typedef struct {
  int32_t host;
  int32_t node;
} back_link;

static int nearer(scored_node first, scored_node second) {
  return first.distance < second.distance || (first.distance == second.distance && first.ordinal < second.ordinal);
}

static int32_t *base_list(const walk_context *context, int32_t ordinal, uint32_t *count) {
  uint32_t capacity = 0;
  node_layer base = {ordinal, 0};
  int32_t *list = list_at(context, base, &capacity);
  *count = list == NULL ? 0 : stored_count(list, capacity);
  return list;
}

static int32_t nearest_in_list(const nearest_pass *pass, int32_t ordinal) {
  if (pass->nearest[ordinal] != NEAREST_NOT_YET_FOUND) { return pass->nearest[ordinal]; }
  const walk_context *context = pass->context;
  uint32_t count = 0;
  const int32_t *list = base_list(context, ordinal, &count);
  scored_node best = {NO_NODE, 0};
  for (uint32_t i = 1; i <= count; i++) {
    int32_t neighbour = list[i];
    if (neighbour == ordinal || !is_live(context, neighbour)) { continue; }
    scored_node scored = {neighbour, pair_distance(context, ordinal, neighbour)};
    if (best.ordinal == NO_NODE || nearer(scored, best)) { best = scored; }
  }
  pass->nearest[ordinal] = best.ordinal;
  return best.ordinal;
}

static uint32_t fallback_hosts_for(const nearest_pass *pass, back_link first, int32_t *hosts) {
  int32_t ordinal = first.node;
  int32_t nearest = first.host;
  const walk_context *context = pass->context;
  scored_node around[NEAREST_LINK_FALLBACK_HOSTS];
  uint32_t kept = 0;
  uint32_t count = 0;
  const int32_t *list = base_list(context, nearest, &count);
  for (uint32_t i = 1; i <= count; i++) {
    int32_t neighbour = list[i];
    if (neighbour == ordinal || !is_live(context, neighbour)) { continue; }
    scored_node scored = {neighbour, pair_distance(context, ordinal, neighbour)};
    if (kept == NEAREST_LINK_FALLBACK_HOSTS && !nearer(scored, around[kept - 1])) { continue; }
    uint32_t slot = kept < NEAREST_LINK_FALLBACK_HOSTS ? kept++ : kept - 1;
    while (slot > 0 && nearer(scored, around[slot - 1])) {
      around[slot] = around[slot - 1];
      slot -= 1;
    }
    around[slot] = scored;
  }
  for (uint32_t i = 0; i < kept; i++) { hosts[i] = around[i].ordinal; }
  return kept;
}

static int64_t replaceable_slot(const nearest_pass *pass, int32_t host, const int32_t *list, uint32_t count) {
  const walk_context *context = pass->context;
  int64_t farthest = -1;
  scored_node farthest_node = {NO_NODE, 0};
  for (uint32_t i = 1; i <= count; i++) {
    int32_t neighbour = list[i];
    if (incoming_count(context, neighbour) < 2) { continue; }
    if (is_live(context, neighbour) && nearest_in_list(pass, neighbour) == host) { continue; }
    scored_node scored = {neighbour, pair_distance(context, host, neighbour)};
    if (farthest == -1 || nearer(farthest_node, scored)) {
      farthest = i;
      farthest_node = scored;
    }
  }
  return farthest;
}

static int link_from(const nearest_pass *pass, back_link link) {
  const walk_context *context = pass->context;
  int32_t host = link.host;
  int32_t ordinal = link.node;
  node_lock(context, host);
  uint32_t count = 0;
  int32_t *list = base_list(context, host, &count);
  int linked = 0;
  if (list != NULL) {
    for (uint32_t i = 1; i <= count && !linked; i++) { linked = list[i] == ordinal; }
    if (!linked && count < list_limit(context->graph, 0)) {
      list[count + 1] = ordinal;
      list[0] = (int32_t)(count + 1);
      note_linked(context, ordinal);
      pass->nearest[host] = NEAREST_NOT_YET_FOUND;
      linked = 1;
    }
    int64_t slot = linked ? -1 : replaceable_slot(pass, host, list, count);
    if (slot != -1) {
      int32_t replaced = list[slot];
      list[slot] = ordinal;
      note_unlinked(context, replaced);
      note_linked(context, ordinal);
      pass->nearest[host] = NEAREST_NOT_YET_FOUND;
      linked = 1;
    }
  }
  node_unlock(context, host);
  return linked;
}

narsil_status link_from_nearest(const walk_context *context) {
  size_t slots = context->slots;
  nearest_pass pass = {context, malloc((slots == 0 ? 1 : slots) * sizeof(int32_t))};
  if (pass.nearest == NULL) { return NARSIL_OUT_OF_MEMORY; }
  for (size_t i = 0; i < slots; i++) { pass.nearest[i] = NEAREST_NOT_YET_FOUND; }
  int32_t hosts[NEAREST_LINK_FALLBACK_HOSTS];
  for (uint32_t ordinal = 0; ordinal < slots; ordinal++) {
    _Atomic(uint8_t) *due = atomic_byte(context->graph->nearest_link_due, ordinal);
    if (atomic_load(due) != 1) { continue; }
    atomic_store(due, 0);
    int32_t node = (int32_t)ordinal;
    if (!is_live(context, node)) { continue; }
    int32_t nearest = nearest_in_list(&pass, node);
    if (nearest == NO_NODE) { continue; }
    back_link first = {nearest, node};
    if (link_from(&pass, first)) { continue; }
    uint32_t host_count = fallback_hosts_for(&pass, first, hosts);
    for (uint32_t i = 0; i < host_count; i++) {
      back_link link = {hosts[i], node};
      if (link_from(&pass, link)) { break; }
    }
  }
  free(pass.nearest);
  return NARSIL_OK;
}
