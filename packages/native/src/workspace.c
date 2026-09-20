#include "internal.h"

#include "../include/narsil_core.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define INITIAL_VISITED_CAPACITY 1024
#define INITIAL_ENTRY_POINT_CAPACITY 256
#define WIDEST_PLANE_CODE_BITS 2

int32_t narsil_core_abi_version(void) { return NARSIL_CORE_ABI_VERSION; }

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
  narsil_workspace *created = calloc(1, sizeof *created);
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
  workspace->normalised = NULL;
  workspace->centred = NULL;
  workspace->dimension_capacity = 0;
  workspace->dimension_scratch_bytes = 0;
}

void narsil_workspace_destroy(narsil_workspace *workspace) {
  if (workspace == NULL) { return; }
  heap_release(&workspace->frontier);
  heap_release(&workspace->found);
  release_dimension_scratch(workspace);
  free(workspace->visited);
  free(workspace->entry_points);
  free(workspace);
}

size_t narsil_workspace_bytes(const narsil_workspace *workspace) {
  if (workspace == NULL) { return 0; }
  size_t heap_entry = sizeof(int32_t) + sizeof(double);
  return sizeof *workspace + ((size_t)workspace->frontier.capacity * heap_entry) +
         ((size_t)workspace->found.capacity * heap_entry) + ((size_t)workspace->visited_capacity * sizeof(uint32_t)) +
         ((size_t)workspace->entry_point_capacity * sizeof(int32_t)) + workspace->dimension_scratch_bytes;
}

narsil_status workspace_reserve_dimension(narsil_workspace *workspace, uint32_t dimension) {
  if (dimension <= workspace->dimension_capacity) { return NARSIL_OK; }
  release_dimension_scratch(workspace);
  size_t pairs = ((size_t)dimension + 1) / 2;
  size_t planes = (size_t)QUERY_PLANES * code_bytes_of(dimension, WIDEST_PLANE_CODE_BITS);
  workspace->normalised = calloc(dimension, sizeof(double));
  workspace->centred = calloc(dimension, sizeof(double));
  workspace->code.levels = calloc(dimension, 1);
  workspace->code.low_levels = calloc(pairs, 1);
  workspace->code.high_levels = calloc(pairs, 1);
  workspace->code.planes = calloc(planes, 1);
  if (workspace->normalised == NULL || workspace->centred == NULL || workspace->code.levels == NULL ||
      workspace->code.low_levels == NULL || workspace->code.high_levels == NULL || workspace->code.planes == NULL) {
    release_dimension_scratch(workspace);
    return NARSIL_OUT_OF_MEMORY;
  }
  workspace->dimension_capacity = dimension;
  workspace->dimension_scratch_bytes = (2 * (size_t)dimension * sizeof(double)) + dimension + (2 * pairs) + planes;
  return NARSIL_OK;
}

narsil_status workspace_reserve_visited(narsil_workspace *workspace, uint32_t slots) {
  if (slots <= workspace->visited_capacity) { return NARSIL_OK; }
  uint32_t held = workspace->visited_capacity == 0 ? INITIAL_VISITED_CAPACITY : workspace->visited_capacity;
  uint32_t capacity = grown_capacity(held, slots);
  uint32_t *visited = calloc(capacity, sizeof *visited);
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
  int32_t *entry_points = realloc(workspace->entry_points, (size_t)capacity * sizeof *entry_points);
  if (entry_points == NULL) { return NARSIL_OUT_OF_MEMORY; }
  workspace->entry_points = entry_points;
  workspace->entry_point_capacity = capacity;
  return NARSIL_OK;
}
