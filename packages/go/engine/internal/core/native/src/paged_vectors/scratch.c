#include "scratch.h"

#include "../../include/narsil_core.h"
#include "../allocation.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

enum { FIRST_HEAP_CAPACITY = 256 };

static int precedes(const paged_heap *heap, double first, double second) {
  return heap->greatest_first ? first > second : first < second;
}

static int precedes_or_equals(const paged_heap *heap, double first, double second) {
  return heap->greatest_first ? first >= second : first <= second;
}

narsil_status paged_heap_push(paged_heap *heap, paged_candidate candidate) {
  if (heap->size == heap->capacity) {
    size_t capacity = heap->capacity == 0 ? FIRST_HEAP_CAPACITY : heap->capacity * 2;
    if (capacity < heap->capacity || capacity > SIZE_MAX / sizeof *heap->entries) { return NARSIL_OUT_OF_MEMORY; }
    void *grown = core_reallocate(heap->entries, capacity * sizeof *heap->entries);
    if (grown == NULL) { return NARSIL_OUT_OF_MEMORY; }
    heap->entries = grown;
    heap->capacity = capacity;
  }
  size_t position = heap->size++;
  while (position > 0) {
    size_t parent = (position - 1) / 2;
    if (precedes_or_equals(heap, heap->entries[parent].distance, candidate.distance)) { break; }
    heap->entries[position] = heap->entries[parent];
    position = parent;
  }
  heap->entries[position] = candidate;
  return NARSIL_OK;
}

paged_candidate paged_heap_pop(paged_heap *heap) {
  paged_candidate first = heap->entries[0];
  paged_candidate last = heap->entries[--heap->size];
  size_t position = 0;
  while (position < heap->size / 2) {
    size_t child = (2 * position) + 1;
    if (child + 1 < heap->size && precedes(heap, heap->entries[child + 1].distance, heap->entries[child].distance)) {
      child++;
    }
    if (precedes_or_equals(heap, last.distance, heap->entries[child].distance)) { break; }
    heap->entries[position] = heap->entries[child];
    position = child;
  }
  if (heap->size > 0) { heap->entries[position] = last; }
  return first;
}

narsil_status paged_vector_reserve(size_t candidates, paged_vector_scratch *scratch, size_t record_bytes) {
  if (candidates > SIZE_MAX / sizeof *scratch->ranked) { return NARSIL_OUT_OF_MEMORY; }
  if (candidates > scratch->ranked_capacity) {
    void *grown = core_reallocate(scratch->ranked, candidates * sizeof *scratch->ranked);
    if (grown == NULL) { return NARSIL_OUT_OF_MEMORY; }
    scratch->ranked = grown;
    scratch->ranked_capacity = candidates;
  }
  if (record_bytes > scratch->record_capacity) {
    void *grown = core_reallocate(scratch->record, record_bytes);
    if (grown == NULL) { return NARSIL_OUT_OF_MEMORY; }
    scratch->record = grown;
    scratch->record_capacity = record_bytes;
  }
  scratch->frontier.size = scratch->found.size = 0;
  scratch->found.greatest_first = 1;
  return NARSIL_OK;
}

void paged_vector_release(paged_vector_scratch *scratch) {
  free(scratch->frontier.entries);
  free(scratch->found.entries);
  free(scratch->ranked);
  free(scratch->record);
  memset(scratch, 0, sizeof *scratch);
}

size_t paged_vector_bytes(const paged_vector_scratch *scratch) {
  return ((scratch->frontier.capacity + scratch->found.capacity + scratch->ranked_capacity) * sizeof(paged_candidate)) +
         scratch->record_capacity;
}
