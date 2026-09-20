#include "internal.h"

#include "../include/narsil_core.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

#define INITIAL_HEAP_CAPACITY 256

narsil_status heap_reserve(distance_heap *heap, uint32_t capacity) {
  if (capacity <= heap->capacity) { return NARSIL_OK; }
  uint32_t held = heap->capacity == 0 ? INITIAL_HEAP_CAPACITY : heap->capacity;
  uint32_t next = grown_capacity(held, capacity);
  int32_t *ordinals = realloc(heap->ordinals, (size_t)next * sizeof *ordinals);
  if (ordinals == NULL) { return NARSIL_OUT_OF_MEMORY; }
  heap->ordinals = ordinals;
  double *distances = realloc(heap->distances, (size_t)next * sizeof *distances);
  if (distances == NULL) { return NARSIL_OUT_OF_MEMORY; }
  heap->distances = distances;
  heap->capacity = next;
  return NARSIL_OK;
}

void heap_release(distance_heap *heap) {
  free(heap->ordinals);
  free(heap->distances);
  heap->ordinals = NULL;
  heap->distances = NULL;
  heap->capacity = 0;
  heap->size = 0;
}

static inline int leaves_first(const distance_heap *heap, double candidate, double other) {
  return heap->greatest_first ? candidate > other : candidate < other;
}

narsil_status heap_push(distance_heap *heap, scored_node node) {
  narsil_status status = heap_reserve(heap, heap->size + 1);
  if (status != NARSIL_OK) { return status; }
  uint32_t index = heap->size;
  heap->size += 1;
  while (index > 0) {
    uint32_t parent = (index - 1) >> 1;
    if (!leaves_first(heap, node.distance, heap->distances[parent])) { break; }
    heap->ordinals[index] = heap->ordinals[parent];
    heap->distances[index] = heap->distances[parent];
    index = parent;
  }
  heap->ordinals[index] = node.ordinal;
  heap->distances[index] = node.distance;
  return NARSIL_OK;
}

int heap_pop(distance_heap *heap) {
  if (heap->size == 0) { return 0; }
  heap->top.ordinal = heap->ordinals[0];
  heap->top.distance = heap->distances[0];
  heap->size -= 1;
  if (heap->size == 0) { return 1; }

  uint32_t size = heap->size;
  int32_t ordinal = heap->ordinals[size];
  double distance = heap->distances[size];
  uint32_t index = 0;
  for (;;) {
    uint32_t left = (2 * index) + 1;
    uint32_t right = left + 1;
    uint32_t first = index;
    double first_distance = distance;
    if (left < size && leaves_first(heap, heap->distances[left], first_distance)) {
      first = left;
      first_distance = heap->distances[left];
    }
    if (right < size && leaves_first(heap, heap->distances[right], first_distance)) { first = right; }
    if (first == index) { break; }
    heap->ordinals[index] = heap->ordinals[first];
    heap->distances[index] = heap->distances[first];
    index = first;
  }
  heap->ordinals[index] = ordinal;
  heap->distances[index] = distance;
  return 1;
}
