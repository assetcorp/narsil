#include "allocation.h"
#include "expansion/internal.h"
#include "facets/scratch.h"
#include "filters/internal.h"
#include "group_merge/scratch.h"
#include "groups/scratch.h"
#include "highlight/scratch.h"
#include "internal.h"
#include "keyword/scratch.h"
#include "paged/cache.h"
#include "paged_vectors/scratch.h"
#include "pattern/internal.h"
#include "phrases/scratch.h"
#include "segments/scratch.h"
#include "terms/scratch.h"

#include "../include/narsil_core.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define INITIAL_VISITED_CAPACITY 1024
#define INITIAL_ENTRY_POINT_CAPACITY 256
#define WIDEST_PLANE_CODE_BITS 2
#define STORED_VECTOR_COPIES 3

int32_t narsil_core_abi_version(void) { return NARSIL_CORE_ABI_VERSION; }

keyword_scratch *workspace_keyword_scratch(narsil_workspace *workspace) { return &workspace->keyword; }
group_merge_scratch *workspace_group_merge_scratch(narsil_workspace *workspace) { return &workspace->group_merge; }
group_scratch *workspace_group_scratch(narsil_workspace *workspace) { return &workspace->groups; }
facet_scratch *workspace_facet_scratch(narsil_workspace *workspace) { return &workspace->facets; }
filter_scratch *workspace_filter_scratch(narsil_workspace *workspace) { return &workspace->filters; }
pattern_scratch *workspace_pattern_scratch(narsil_workspace *workspace) { return &workspace->pattern; }
term_scratch *workspace_term_scratch(narsil_workspace *workspace) { return &workspace->terms; }
segment_scratch *workspace_segment_scratch(narsil_workspace *workspace) { return &workspace->segments; }
phrase_scratch *workspace_phrase_scratch(narsil_workspace *workspace) { return &workspace->phrases; }
expansion_scratch *workspace_expansion_scratch(narsil_workspace *workspace) { return &workspace->expansion; }
highlight_scratch *workspace_highlight_scratch(narsil_workspace *workspace) { return &workspace->highlight; }
paged_scratch *workspace_paged_scratch(narsil_workspace *workspace) { return &workspace->paged; }
paged_vector_scratch *workspace_paged_vector_scratch(narsil_workspace *workspace) { return &workspace->paged_vectors; }

uint32_t grown_capacity(uint32_t first, uint32_t needed) {
  uint32_t capacity = first;
  while (capacity < needed) {
    if (capacity > UINT32_MAX / 2) { return needed; }
    capacity *= 2;
  }
  return capacity;
}

narsil_status narsil_workspace_create(narsil_workspace **workspace) {
  if (workspace == NULL) { return NARSIL_INVALID_ARGUMENT; }
  narsil_workspace *created = core_allocate_zeroed(1, sizeof *created);
  if (created == NULL) { return NARSIL_OUT_OF_MEMORY; }
  created->found.greatest_first = 1;
  *workspace = created;
  return NARSIL_OK;
}

static void release_code(prepared_code *code) {
  free(code->levels);
  free(code->low_levels);
  free(code->high_levels);
  free(code->planes);
  memset(code, 0, sizeof *code);
}

static void release_dimension_scratch(narsil_workspace *workspace) {
  release_code(&workspace->code);
  free(workspace->normalised);
  free(workspace->centred);
  free(workspace->placed_vector);
  free(workspace->stored_vector);
  free(workspace->other_vector);
  workspace->normalised = NULL;
  workspace->centred = NULL;
  workspace->placed_vector = NULL;
  workspace->stored_vector = NULL;
  workspace->other_vector = NULL;
  workspace->dimension_capacity = 0;
  workspace->dimension_scratch_bytes = 0;
}

void narsil_workspace_destroy(narsil_workspace *workspace) {
  if (workspace == NULL) { return; }
  heap_release(&workspace->frontier);
  heap_release(&workspace->found);
  release_dimension_scratch(workspace);
  list_release(&workspace->layer_candidates);
  list_release(&workspace->link_candidates);
  list_release(&workspace->repair_candidates);
  list_release(&workspace->dropped_links);
  free(workspace->selections);
  free(workspace->selection_counts);
  free(workspace->visited);
  free(workspace->entry_points);
  keyword_scratch_release(&workspace->keyword);
  free(workspace->group_merge.allocation);
  free(workspace->groups.allocation);
  free(workspace->sort.allocation);
  free(workspace->sort_order.allocation);
  free(workspace->facets.allocation);
  free(workspace->filters.words);
  free(workspace->filters.geo.edges);
  pattern_scratch_release(&workspace->pattern);
  term_scratch_release(&workspace->terms);
  segment_scratch_release(&workspace->segments);
  phrase_scratch_release(&workspace->phrases);
  expansion_scratch_release(&workspace->expansion);
  highlight_release(&workspace->highlight);
  free(workspace->paged.page);
  free(workspace->paged.values);
  free(workspace->paged.offsets);
  paged_vector_release(&workspace->paged_vectors);
  free(workspace);
}

static size_t list_bytes(const scored_list *list) {
  return (size_t)list->capacity * (sizeof(int32_t) + sizeof(double));
}

static size_t link_bytes(const narsil_workspace *workspace) {
  size_t selected = (size_t)workspace->selection_layers * workspace->selection_stride * sizeof(int32_t);
  size_t counts = (size_t)workspace->selection_layers * sizeof(uint32_t);
  return list_bytes(&workspace->layer_candidates) + list_bytes(&workspace->link_candidates) +
         list_bytes(&workspace->repair_candidates) + list_bytes(&workspace->dropped_links) + selected + counts;
}

narsil_status workspace_reserve_links(narsil_workspace *workspace, const narsil_graph *graph, uint32_t layers) {
  uint32_t stride = list_limit(graph, 0) > list_limit(graph, 1) ? list_limit(graph, 0) : list_limit(graph, 1);
  if (layers <= workspace->selection_layers && stride <= workspace->selection_stride) { return NARSIL_OK; }
  uint32_t held_layers = layers > workspace->selection_layers ? layers : workspace->selection_layers;
  uint32_t held_stride = stride > workspace->selection_stride ? stride : workspace->selection_stride;
  int32_t *selections = core_allocate_zeroed((size_t)held_layers * held_stride, sizeof *selections);
  uint32_t *counts = core_allocate_zeroed(held_layers, sizeof *counts);
  if (selections == NULL || counts == NULL) {
    free(selections);
    free(counts);
    return NARSIL_OUT_OF_MEMORY;
  }
  free(workspace->selections);
  free(workspace->selection_counts);
  workspace->selections = selections;
  workspace->selection_counts = counts;
  workspace->selection_layers = held_layers;
  workspace->selection_stride = held_stride;
  return NARSIL_OK;
}

size_t narsil_workspace_bytes(const narsil_workspace *workspace) {
  if (workspace == NULL) { return 0; }
  size_t heap_entry = sizeof(int32_t) + sizeof(double);
  return sizeof *workspace + ((size_t)workspace->frontier.capacity * heap_entry) +
         ((size_t)workspace->found.capacity * heap_entry) + ((size_t)workspace->visited_capacity * sizeof(uint32_t)) +
         ((size_t)workspace->entry_point_capacity * sizeof(int32_t)) + workspace->dimension_scratch_bytes +
         link_bytes(workspace) + keyword_scratch_bytes(&workspace->keyword) + workspace->group_merge.bytes +
         workspace->groups.bytes + workspace->sort.bytes + workspace->sort_order.bytes + workspace->facets.bytes +
         (workspace->filters.capacity * sizeof *workspace->filters.words) +
         (workspace->filters.geo.capacity * sizeof *workspace->filters.geo.edges) +
         pattern_scratch_bytes(&workspace->pattern) + term_scratch_bytes(&workspace->terms) +
         segment_scratch_bytes(&workspace->segments) + phrase_scratch_bytes(&workspace->phrases) +
         expansion_scratch_bytes(&workspace->expansion) + highlight_bytes(&workspace->highlight) +
         workspace->paged.capacity + workspace->paged.value_capacity + workspace->paged.offset_capacity +
         paged_vector_bytes(&workspace->paged_vectors);
}

narsil_status workspace_reserve_dimension(narsil_workspace *workspace, uint32_t dimension) {
  if (dimension <= workspace->dimension_capacity) { return NARSIL_OK; }
  release_dimension_scratch(workspace);
  size_t pairs = ((size_t)dimension + 1) / 2;
  size_t planes = (size_t)QUERY_PLANES * code_bytes_of(dimension, WIDEST_PLANE_CODE_BITS);
  workspace->normalised = core_allocate_zeroed(dimension, sizeof(double));
  workspace->centred = core_allocate_zeroed(dimension, sizeof(double));
  workspace->placed_vector = core_allocate_zeroed(dimension, sizeof(float));
  workspace->stored_vector = core_allocate_zeroed(dimension, sizeof(float));
  workspace->other_vector = core_allocate_zeroed(dimension, sizeof(float));
  workspace->code.levels = core_allocate_zeroed(dimension, 1);
  workspace->code.low_levels = core_allocate_zeroed(pairs, 1);
  workspace->code.high_levels = core_allocate_zeroed(pairs, 1);
  workspace->code.planes = core_allocate_zeroed(planes, 1);
  if (workspace->normalised == NULL || workspace->centred == NULL || workspace->placed_vector == NULL ||
      workspace->stored_vector == NULL || workspace->other_vector == NULL || workspace->code.levels == NULL ||
      workspace->code.low_levels == NULL || workspace->code.high_levels == NULL || workspace->code.planes == NULL) {
    release_dimension_scratch(workspace);
    return NARSIL_OUT_OF_MEMORY;
  }
  workspace->dimension_capacity = dimension;
  workspace->dimension_scratch_bytes = (2 * (size_t)dimension * sizeof(double)) +
                                       (STORED_VECTOR_COPIES * (size_t)dimension * sizeof(float)) + dimension +
                                       (2 * pairs) + planes;
  return NARSIL_OK;
}

narsil_status workspace_reserve_visited(narsil_workspace *workspace, uint32_t slots) {
  if (slots <= workspace->visited_capacity) { return NARSIL_OK; }
  uint32_t held = workspace->visited_capacity == 0 ? INITIAL_VISITED_CAPACITY : workspace->visited_capacity;
  uint32_t capacity = grown_capacity(held, slots);
  uint32_t *visited = core_allocate_zeroed(capacity, sizeof *visited);
  if (visited == NULL) { return NARSIL_OUT_OF_MEMORY; }
  if (workspace->visited != NULL) {
    memcpy(visited, workspace->visited, (size_t)workspace->visited_capacity * sizeof *visited);
    free(workspace->visited);
  }
  workspace->visited = visited;
  workspace->visited_capacity = capacity;
  return NARSIL_OK;
}

narsil_status workspace_reserve_entry_points(narsil_workspace *workspace, uint32_t count) {
  if (count <= workspace->entry_point_capacity) { return NARSIL_OK; }
  uint32_t held = workspace->entry_point_capacity == 0 ? INITIAL_ENTRY_POINT_CAPACITY : workspace->entry_point_capacity;
  uint32_t capacity = grown_capacity(held, count);
  int32_t *entry_points = core_reallocate(workspace->entry_points, (size_t)capacity * sizeof *entry_points);
  if (entry_points == NULL) { return NARSIL_OUT_OF_MEMORY; }
  workspace->entry_points = entry_points;
  workspace->entry_point_capacity = capacity;
  return NARSIL_OK;
}
