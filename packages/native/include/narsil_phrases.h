#ifndef NARSIL_PHRASES_H
#define NARSIL_PHRASES_H

#include "narsil_core.h"
#include "narsil_work.h"

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
  const uint32_t *documents;
  const uint16_t *fields;
  const uint32_t *position_starts;
  const uint32_t *position_counts;
  size_t count;
  const uint32_t *positions;
  size_t position_count;
  int ordered;
} narsil_phrase_postings;

typedef struct {
  const narsil_phrase_postings *postings;
  size_t token_count;
  const uint32_t *starts;
  size_t phrase_count;
  const uint32_t *tokens;
  const uint32_t *offsets;
  size_t entry_count;
  const uint8_t *searchable;
  uint32_t field_count;
  const uint32_t *filter;
  size_t filter_words;
  const uint32_t *removed;
  size_t removed_words;
  uint32_t ordinal_count;
  int collect;
  narsil_work_meter meter;
} narsil_phrase_request;

typedef struct {
  uint32_t *matched;
  size_t matched_words;
  uint32_t *starts;
  size_t start_capacity;
  uint32_t *documents;
  uint16_t *fields;
  uint32_t *frequencies;
  size_t document_capacity;
  size_t field_capacity;
  size_t frequency_capacity;
} narsil_phrase_output;

narsil_status narsil_match_phrases(narsil_workspace *workspace, const narsil_phrase_request *request,
                                   const narsil_phrase_output *output, uint32_t *row_count);

#ifdef __cplusplus
}
#endif

#endif
