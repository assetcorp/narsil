#include "internal.h"

#include "../../include/narsil_core.h"
#include "../internal.h"
#include "../work/tally.h"
#include "scratch.h"

#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

static narsil_status keep(paged_walk *walk, paged_candidate candidate) {
  narsil_status status = paged_heap_push(&walk->scratch->frontier, candidate);
  if (status != NARSIL_OK || (walk->layer == 0 && !paged_admits(walk, candidate.ordinal))) { return status; }
  status = paged_heap_push(&walk->scratch->found, candidate);
  if (status == NARSIL_OK && walk->scratch->found.size > walk->candidate_limit) {
    (void)paged_heap_pop(&walk->scratch->found);
  }
  return status;
}

static double furthest(const paged_heap *found) { return found->size == 0 ? HUGE_VAL : found->entries[0].distance; }

static narsil_status visit_neighbours(paged_walk *walk, uint32_t ordinal) {
  uint64_t start = 0;
  uint32_t count = 0;
  narsil_status status = paged_neighbours(walk, ordinal, &start, &count);
  if (status != NARSIL_OK) { return status; }
  status = work_tally_add(&walk->work, (uint64_t)count * walk->field->dimension);
  if (status != NARSIL_OK) { return status; }
  struct narsil_workspace *workspace = walk->workspace;
  for (uint32_t at = 0; at < count; at++) {
    uint32_t neighbour = 0;
    status = paged_neighbour(walk, ordinal, &neighbour, start + ((uint64_t)at * sizeof(uint32_t)));
    if (status != NARSIL_OK) { return status; }
    if (neighbour >= walk->field->total || workspace->visited[neighbour] == workspace->stamp) { continue; }
    workspace->visited[neighbour] = workspace->stamp;
    if (paged_levels(walk->field, neighbour) <= walk->layer) { continue; }
    paged_candidate candidate = {neighbour, 0};
    status = paged_vector_distance(walk, neighbour, &candidate.distance, 0);
    if (status != NARSIL_OK) { return status; }
    if (candidate.distance == HUGE_VAL) { continue; }
    if (candidate.distance < furthest(&walk->scratch->found) || walk->scratch->found.size < walk->candidate_limit) {
      status = keep(walk, candidate);
      if (status != NARSIL_OK) { return status; }
    }
  }
  return NARSIL_OK;
}

narsil_status paged_walk_layer(paged_walk *walk, uint32_t entry, paged_layer layer) {
  walk->layer = layer.level;
  walk->candidate_limit = layer.limit;
  struct narsil_workspace *workspace = walk->workspace;
  workspace->stamp++;
  if (workspace->stamp == 0) {
    memset(workspace->visited, 0, (size_t)workspace->visited_capacity * sizeof *workspace->visited);
    workspace->stamp = 1;
  }
  walk->scratch->frontier.size = walk->scratch->found.size = 0;
  workspace->visited[entry] = workspace->stamp;
  paged_candidate first = {entry, 0};
  narsil_status status = paged_vector_distance(walk, entry, &first.distance, 0);
  if (status != NARSIL_OK || first.distance == HUGE_VAL) { return status; }
  status = keep(walk, first);
  if (status != NARSIL_OK) { return status; }
  while (walk->scratch->frontier.size > 0) {
    paged_candidate next = paged_heap_pop(&walk->scratch->frontier);
    if (next.distance > furthest(&walk->scratch->found) && walk->scratch->found.size >= walk->candidate_limit) {
      break;
    }
    status = visit_neighbours(walk, next.ordinal);
    if (status != NARSIL_OK) { return status; }
  }
  return NARSIL_OK;
}
