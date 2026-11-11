#ifndef NARSIL_PAGED_VECTOR_INTERNAL_H
#define NARSIL_PAGED_VECTOR_INTERNAL_H

#include "../../include/narsil_paged_vectors.h"
#include "../internal.h"
#include "../segments/regions.h"
#include "../work/tally.h"
#include "scratch.h"

#include <stddef.h>
#include <stdint.h>

enum { PAGED_GRAPH_PART_NODES = 16384, PAGED_MAX_LAYER = 32, PAGED_BIT_WORD_BITS = 32, PAGED_BYTE_BITS = 8 };

typedef struct {
  narsil_workspace *workspace;
  narsil_page_cache *cache;
  const narsil_paged_vector_field *field;
  const narsil_paged_vector_request *request;
  narsil_page_fault *fault;
  paged_vector_scratch *scratch;
  work_tally work;
  narsil_store code_store;
  walk_context codes;
  double magnitude;
  uint32_t layer;
  uint32_t candidate_limit;
} paged_walk;

typedef struct {
  uint32_t limit;
  uint32_t level;
} paged_layer;

int paged_vector_regions(segment_regions *regions, const narsil_page_cache *cache,
                         const narsil_paged_vector_field *field, const narsil_paged_vector_request *request,
                         const narsil_paged_vector_output *output, const uint32_t *count,
                         const narsil_page_fault *fault);
narsil_status paged_vector_validate(const segment_regions *regions, const narsil_paged_vector_field *field,
                                    const narsil_paged_vector_request *request, narsil_page_fault *fault);
const narsil_paged_vector_file *paged_file_of(const narsil_paged_vector_field *field, uint32_t ordinal);
uint8_t paged_levels(const narsil_paged_vector_field *field, uint32_t ordinal);
int paged_admits(const paged_walk *walk, uint32_t ordinal);
narsil_status paged_vector_distance(paged_walk *walk, uint32_t ordinal, double *distance, int exact);
narsil_status paged_neighbours(paged_walk *walk, uint32_t ordinal, uint64_t *start, uint32_t *count);
narsil_status paged_neighbour(paged_walk *walk, uint32_t ordinal, uint32_t *neighbour, uint64_t position);
narsil_status paged_walk_layer(paged_walk *walk, uint32_t entry, paged_layer layer);

#endif
