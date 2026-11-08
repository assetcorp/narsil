#ifndef NARSIL_FROZEN_SEGMENTS_H
#define NARSIL_FROZEN_SEGMENTS_H

#include "narsil_core.h"
#include "narsil_segments.h"

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
  const uint8_t *text;
  size_t text_bytes;
  const uint32_t *offsets;
  const uint32_t *counts;
  size_t count;
} narsil_frozen_strings;

typedef struct {
  const uint32_t *starts;
  const uint32_t *rows;
  const uint32_t *term_of_slot;
} narsil_frozen_removal_index;

typedef struct {
  narsil_frozen_strings terms;
  const uint32_t *payload_slots;
  const uint32_t *posting_offsets;
  const uint32_t *posting_documents;
  const uint16_t *posting_frequencies;
  const uint16_t *posting_fields;
  size_t posting_count;
  const narsil_frozen_strings *surfaces;
  const narsil_frozen_strings *spellings;
  const uint32_t *spelling_tokens;
  const narsil_frozen_removal_index *removal_index;
  const uint8_t *partial_fields;
  uint32_t field_count;
  uint32_t document_count;
  const uint32_t *removal_terms;
  size_t removal_words;
} narsil_frozen_segment;

typedef struct {
  uint32_t *tombstones;
  uint32_t *tombstone_count;
  uint32_t *removed_documents;
  double *removed_occurrences;
  uint32_t *removed_surfaces;
  uint32_t *removed_spellings;
} narsil_frozen_segment_state;

typedef struct {
  const narsil_frozen_segment *segment;
  narsil_frozen_segment_state *state;
  uint32_t ordinal;
  const narsil_field_tokens *fields;
  size_t field_count;
} narsil_remove_frozen_request;

narsil_status narsil_remove_frozen_document(narsil_workspace *workspace, const narsil_remove_frozen_request *request);

typedef struct {
  uint32_t *entries;
  double *values;
  size_t entry_capacity;
  size_t value_capacity;
} narsil_frozen_removal_output;

narsil_status narsil_prepare_frozen_removal(narsil_workspace *workspace, const narsil_remove_frozen_request *request,
                                            const narsil_frozen_removal_output *output, size_t *count);

#ifdef __cplusplus
}
#endif

#endif
