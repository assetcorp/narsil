#ifndef NARSIL_SEGMENT_MERGE_H
#define NARSIL_SEGMENT_MERGE_H

#include "narsil_core.h"
#include "narsil_frozen_segments.h"

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
  narsil_frozen_strings terms;
  const uint32_t *payload_slots;
  const uint32_t *posting_offsets;
  const uint32_t *posting_documents;
  const uint16_t *posting_frequencies;
  const uint16_t *posting_fields;
  size_t posting_count;
  const uint32_t *position_offsets;
  const uint32_t *position_values;
  size_t position_count;
  const uint32_t *mapping;
  const uint16_t *field_mapping;
  const uint32_t *const *field_lengths;
  uint32_t document_count;
  uint32_t field_count;
  const narsil_frozen_strings *surfaces;
  const narsil_frozen_strings *spellings;
  const narsil_growing_segment *growing;
} narsil_keyword_merge_input;

typedef struct {
  const narsil_keyword_merge_input *inputs;
  size_t input_count;
  uint32_t document_count;
  uint32_t field_count;
  const narsil_frozen_strings *retained_terms;
} narsil_keyword_merge_request;

typedef struct {
  uint32_t terms;
  uint32_t term_bytes;
  uint32_t postings;
  uint32_t positions;
  uint32_t has_positions;
  uint32_t surfaces;
  uint32_t surface_bytes;
  uint32_t spellings;
  uint32_t spelling_bytes;
} narsil_keyword_merge_sizes;

typedef struct {
  uint8_t *text;
  uint32_t *offsets;
  uint32_t *counts;
  size_t count_capacity;
  size_t text_capacity;
  size_t offset_capacity;
} narsil_merged_strings;

typedef struct {
  narsil_merged_strings terms;
  uint32_t *posting_offsets;
  size_t posting_offset_capacity;
  uint32_t *posting_documents;
  uint16_t *posting_frequencies;
  uint16_t *posting_fields;
  size_t posting_capacity;
  uint32_t *position_offsets;
  size_t position_offset_capacity;
  uint32_t *position_values;
  size_t position_capacity;
  uint32_t *field_lengths;
  size_t field_length_capacity;
  double *total_field_lengths;
  size_t field_count;
  narsil_merged_strings surfaces;
  narsil_merged_strings spellings;
} narsil_keyword_merge_output;

narsil_status narsil_measure_merge(narsil_workspace *workspace, const narsil_keyword_merge_request *request,
                                   narsil_keyword_merge_sizes *sizes);
narsil_status narsil_write_merge(narsil_workspace *workspace, const narsil_keyword_merge_request *request,
                                 const narsil_keyword_merge_output *output);

#ifdef __cplusplus
}
#endif

#endif
