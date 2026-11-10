#ifndef NARSIL_PAGED_VECTORS_H
#define NARSIL_PAGED_VECTORS_H

#include "narsil_core.h"
#include "narsil_paged.h"
#include "narsil_work.h"

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
  uint32_t first;
  uint32_t count;
  const uint8_t *dead;
  size_t dead_bytes;
  narsil_page_section vectors;
  const narsil_page_section *records;
} narsil_paged_vector_file;

typedef struct {
  uint32_t first;
  uint32_t count;
  const uint8_t *levels;
  size_t level_count;
  const uint32_t *node_offsets;
  size_t offset_count;
  narsil_page_section neighbours;
} narsil_paged_graph_part;

typedef struct {
  uint32_t dimension;
  uint32_t metric;
  uint32_t total;
  uint32_t entry_point;
  int has_entry_point;
  uint32_t max_layer;
  uint32_t bits;
  const float *centroid;
  size_t centroid_count;
  const narsil_paged_vector_file *files;
  size_t file_count;
  const narsil_paged_graph_part *parts;
  size_t part_count;
} narsil_paged_vector_field;

typedef struct {
  const float *query;
  size_t query_count;
  uint32_t k;
  uint32_t ef;
  uint32_t rescore_depth;
  int explicit_rescore_window;
  double min_similarity;
  const uint32_t *accepted;
  size_t accepted_words;
  const uint32_t *excluded;
  size_t excluded_words;
  narsil_work_meter meter;
} narsil_paged_vector_request;

typedef struct {
  uint32_t *ordinals;
  size_t ordinal_capacity;
  double *scores;
  size_t score_capacity;
} narsil_paged_vector_output;

narsil_status narsil_search_paged_vectors(narsil_workspace *workspace, narsil_page_cache *cache,
                                          const narsil_paged_vector_field *field,
                                          const narsil_paged_vector_request *request,
                                          const narsil_paged_vector_output *output, uint32_t *count,
                                          narsil_page_fault *fault);

#ifdef __cplusplus
}
#endif

#endif
