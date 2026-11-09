#ifndef NARSIL_FROZEN_SEGMENTS_H
#define NARSIL_FROZEN_SEGMENTS_H

#include "narsil_core.h"
#include "narsil_paged.h"
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
} narsil_frozen_segment;

enum {
  NARSIL_PENDING_HEADER_WORDS = 8,
  NARSIL_PENDING_DOCUMENTS = 0,
  NARSIL_PENDING_TOKENS = 1,
  NARSIL_PENDING_UNITS = 2,
  NARSIL_PENDING_TOKEN_WORDS = 5
};

typedef struct {
  uint32_t *tombstones;
  uint32_t *tombstone_count;
  uint32_t *removed_documents;
  double *removed_occurrences;
  uint32_t *removed_surfaces;
  uint32_t *removed_spellings;
  uint32_t *pending_header;
  uint32_t *pending_documents;
  size_t pending_document_capacity;
  uint32_t *pending_tokens;
  size_t pending_token_capacity;
  uint16_t *pending_units;
  size_t pending_unit_capacity;
} narsil_frozen_segment_state;

typedef struct {
  narsil_page_cache *cache;
  const narsil_page_section *offsets;
  const narsil_page_section *values;
  narsil_page_fault *fault;
} narsil_frozen_paged_removals;

typedef struct {
  const narsil_frozen_segment *segment;
  narsil_frozen_segment_state *state;
  uint32_t ordinal;
  const narsil_field_tokens *fields;
  size_t field_count;
  const narsil_frozen_paged_removals *paged;
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

narsil_status narsil_settle_frozen_state(narsil_workspace *workspace, const narsil_frozen_segment *segment,
                                         narsil_frozen_segment_state *state, const narsil_frozen_paged_removals *paged);

#ifdef __cplusplus
}
#endif

#endif
