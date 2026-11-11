#ifndef NARSIL_PAGED_VECTOR_SCRATCH_H
#define NARSIL_PAGED_VECTOR_SCRATCH_H

#include "../../include/narsil_core.h"

#include <stddef.h>
#include <stdint.h>

typedef struct {
  uint32_t ordinal;
  double distance;
} paged_candidate;

typedef struct {
  paged_candidate *entries;
  size_t size;
  size_t capacity;
  int greatest_first;
} paged_heap;

typedef struct {
  paged_heap frontier;
  paged_heap found;
  paged_candidate *ranked;
  size_t ranked_capacity;
  uint8_t *record;
  size_t record_capacity;
} paged_vector_scratch;

paged_vector_scratch *workspace_paged_vector_scratch(narsil_workspace *workspace);
narsil_status paged_heap_push(paged_heap *heap, paged_candidate candidate);
paged_candidate paged_heap_pop(paged_heap *heap);
narsil_status paged_vector_reserve(size_t candidates, paged_vector_scratch *scratch, size_t record_bytes);
void paged_vector_release(paged_vector_scratch *scratch);
size_t paged_vector_bytes(const paged_vector_scratch *scratch);

#endif
