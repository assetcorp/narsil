#ifndef NARSIL_KEYWORD_H
#define NARSIL_KEYWORD_H

#include "narsil_core.h"

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define NARSIL_KEYWORD_TERM_SLOT 0U
#define NARSIL_KEYWORD_GROUP_SLOT 1U
#define NARSIL_KEYWORD_PHRASE_SLOT 2U

#define NARSIL_KEYWORD_SLOT_STRIDE 4U
#define NARSIL_KEYWORD_SLOT_KIND 0U
#define NARSIL_KEYWORD_SLOT_TERM 1U
#define NARSIL_KEYWORD_SLOT_LIST_END 2U
#define NARSIL_KEYWORD_SLOT_VALUE_END 3U

#define NARSIL_KEYWORD_LIST_STRIDE 3U
#define NARSIL_KEYWORD_LIST_FLAGS 0U
#define NARSIL_KEYWORD_LIST_START 1U
#define NARSIL_KEYWORD_LIST_LENGTH 2U
#define NARSIL_KEYWORD_LIST_FROM_ROWS 1U
#define NARSIL_KEYWORD_LIST_ORDERED 2U

#define NARSIL_KEYWORD_LIST_VALUE_STRIDE 2U
#define NARSIL_KEYWORD_LIST_DOCUMENT_FREQUENCY 0U
#define NARSIL_KEYWORD_LIST_FACTOR 0U
#define NARSIL_KEYWORD_LIST_PARTIAL_FACTOR 1U

#define NARSIL_KEYWORD_FIELD_BOOSTS 0U
#define NARSIL_KEYWORD_FIELD_AVERAGE_LENGTHS 1U
#define NARSIL_KEYWORD_FIELD_K1 2U
#define NARSIL_KEYWORD_FIELD_B 3U
#define NARSIL_KEYWORD_FIELD_NUMBER_COLUMNS 4U

#define NARSIL_KEYWORD_SCORED_IN_FULL 0U
#define NARSIL_KEYWORD_PRUNED 1U
#define NARSIL_KEYWORD_PRUNED_THEN_FULL 2U

#define NARSIL_KEYWORD_NO_LIMIT (-1.0)
#define NARSIL_KEYWORD_MAX_FIELDS 65536U

typedef struct {
  const uint32_t *values;
  uint32_t length;
} narsil_keyword_column;

typedef struct {
  const uint32_t *pool_doc_ids;
  const uint16_t *pool_frequencies;
  const uint16_t *pool_fields;
  uint32_t pool_length;
  const uint32_t *row_doc_ids;
  const double *row_frequencies;
  const uint16_t *row_fields;
  uint32_t row_length;
  const uint32_t *slots;
  uint32_t slot_count;
  uint32_t slot_capacity;
  const uint32_t *lists;
  const double *list_values;
  uint32_t list_capacity;
  const double *slot_values;
  uint32_t slot_value_capacity;
  uint32_t field_count;
  const uint8_t *searchable;
  const uint8_t *partial_marks;
  const uint16_t *name_ranks;
  const double *field_numbers;
  const narsil_keyword_column *lengths;
  int has_filter;
  const uint32_t *filter;
  uint32_t filter_words;
  const uint32_t *live;
  uint32_t live_words;
  const uint32_t *removed;
  uint32_t removed_words;
  double terms;
  uint32_t capacity;
  double total_documents;
  double term_match;
  double limit;
  double min_score;
  int collect;
} narsil_keyword_request;

typedef struct {
  int32_t *ordinals;
  double *scores;
  uint32_t length;
  uint32_t *matched;
  uint32_t matched_words;
  uint32_t count;
  uint32_t total_matched;
  uint32_t scoring_path;
} narsil_keyword_output;

narsil_status narsil_keyword_score(narsil_workspace *workspace, const narsil_keyword_request *request,
                                   narsil_keyword_output *output);

#ifdef __cplusplus
}
#endif

#endif
