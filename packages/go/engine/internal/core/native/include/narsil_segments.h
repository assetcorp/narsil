#ifndef NARSIL_SEGMENTS_H
#define NARSIL_SEGMENTS_H

#include "narsil_analysis.h"
#include "narsil_core.h"
#include "narsil_terms.h"

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
  uint32_t *slice_start;
  uint8_t *slice_class;
  uint32_t *lengths;
  uint32_t *doc_frequency;
  uint32_t *dead_documents;
  double *total_term_frequency;
  double *surface_occurrences;
  uint32_t *revision;
  uint8_t *flags;
  size_t capacity;
} narsil_term_columns;

typedef struct {
  uint32_t *allocation;
  uint32_t *free_heads;
  const uint32_t *slice_capacities;
  size_t class_count;
} narsil_slice_allocator;

typedef struct {
  uint32_t *doc_ids;
  uint16_t *frequencies;
  uint16_t *field_indices;
  uint32_t *position_starts;
  size_t capacity;
  narsil_slice_allocator allocator;
} narsil_posting_pool;

typedef struct {
  uint32_t *values;
  size_t capacity;
  uint32_t *allocation;
} narsil_position_pool;

typedef struct {
  narsil_term_table strings;
  uint32_t *token;
  uint32_t *count;
  size_t capacity;
} narsil_surface_table;

typedef struct {
  uint32_t *header;
  int32_t *slots;
  size_t slot_capacity;
  uint32_t *runs;
  uint32_t *list_start;
  uint32_t *list_length;
  uint8_t *list_class;
  size_t capacity;
  uint32_t *members;
  size_t member_capacity;
  narsil_slice_allocator allocator;
} narsil_run_table;

typedef struct {
  narsil_surface_table entries;
  uint32_t *code_points;
  narsil_run_table runs;
} narsil_spelling_table;

typedef struct {
  narsil_term_table terms;
  narsil_term_columns columns;
  narsil_posting_pool postings;
  narsil_position_pool *positions;
  narsil_surface_table *surfaces;
  narsil_spelling_table *spellings;
  uint32_t *retired;
  uint32_t *field_lengths;
  uint32_t *total_documents;
  double *total_field_lengths;
  const uint8_t *partial_fields;
  uint32_t ordinal_capacity;
  uint32_t field_count;
} narsil_growing_segment;

typedef struct {
  uint16_t field;
  narsil_tokens tokens;
} narsil_field_tokens;

typedef struct {
  narsil_growing_segment *segment;
  uint32_t ordinal;
  const narsil_field_tokens *fields;
  size_t field_count;
} narsil_index_terms_request;

narsil_status narsil_index_terms(narsil_workspace *workspace, const narsil_index_terms_request *request);
narsil_status narsil_remove_document(narsil_workspace *workspace, const narsil_index_terms_request *request);
narsil_status narsil_begin_batch(narsil_workspace *workspace, narsil_growing_segment *segment);
narsil_status narsil_end_batch(narsil_workspace *workspace, narsil_growing_segment *segment);

#ifdef __cplusplus
}
#endif

#endif
