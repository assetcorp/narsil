#ifndef NARSIL_KEYWORD_PASS_H
#define NARSIL_KEYWORD_PASS_H

#include "scratch.h"

#include "../../include/narsil_keyword.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

#define KEYWORD_BITS_PER_WORD 32U
#define KEYWORD_WORD_SHIFT 5U
#define KEYWORD_BIT_MASK 31U

typedef struct {
  const narsil_keyword_request *request;
  keyword_scratch *scratch;
  narsil_keyword_output *output;
  const double *boosts;
  const double *averages;
  const double *k1s;
  const double *bs;
  uint32_t field_count;
  uint32_t capacity;
  uint32_t list_count;
  int tracks_coverage;
  int has_limit;
  uint32_t limit;
  const uint32_t *scorable_bits;
  uint32_t scorable_words;
} keyword_pass;

typedef struct {
  const uint32_t *doc_ids;
  const uint16_t *fields;
  const uint16_t *narrow_frequencies;
  const double *wide_frequencies;
} keyword_rows;

double keyword_idf(double document_frequency, double total_documents);
void keyword_list_rows(const keyword_pass *pass, uint32_t list, keyword_rows *rows);

static inline double keyword_frequency(const keyword_rows *rows, uint32_t row) {
  return rows->wide_frequencies != NULL ? rows->wide_frequencies[row] : (double)rows->narrow_frequencies[row];
}

static inline uint32_t keyword_list_start(const narsil_keyword_request *request, uint32_t list) {
  return request->lists[((size_t)list * NARSIL_KEYWORD_LIST_STRIDE) + NARSIL_KEYWORD_LIST_START];
}

static inline uint32_t keyword_list_length(const narsil_keyword_request *request, uint32_t list) {
  return request->lists[((size_t)list * NARSIL_KEYWORD_LIST_STRIDE) + NARSIL_KEYWORD_LIST_LENGTH];
}

static inline uint32_t keyword_list_flags(const narsil_keyword_request *request, uint32_t list) {
  return request->lists[((size_t)list * NARSIL_KEYWORD_LIST_STRIDE) + NARSIL_KEYWORD_LIST_FLAGS];
}

static inline double keyword_list_value(const narsil_keyword_request *request, uint32_t list, uint32_t column) {
  return request->list_values[((size_t)list * NARSIL_KEYWORD_LIST_VALUE_STRIDE) + column];
}

static inline uint32_t keyword_words_for(uint32_t capacity) {
  return (capacity + KEYWORD_BITS_PER_WORD - 1U) / KEYWORD_BITS_PER_WORD;
}

static inline int keyword_holds(const uint32_t *bits, uint32_t words, uint32_t ordinal) {
  uint32_t word = ordinal >> KEYWORD_WORD_SHIFT;
  return word < words && ((bits[word] >> (ordinal & KEYWORD_BIT_MASK)) & 1U) == 1U;
}

static inline double keyword_kept_or_zero(double value, uint32_t keep) {
  uint64_t bits = 0;
  memcpy(&bits, &value, sizeof bits);
  bits &= (uint64_t)0 - (uint64_t)keep;
  double kept = 0;
  memcpy(&kept, &bits, sizeof kept);
  return kept;
}

static inline int keyword_scorable(const keyword_pass *pass, uint32_t ordinal) {
  if (pass->scorable_bits != NULL) { return keyword_holds(pass->scorable_bits, pass->scorable_words, ordinal); }
  const narsil_keyword_request *request = pass->request;
  if (ordinal >= pass->capacity || !keyword_holds(request->live, request->live_words, ordinal) ||
      keyword_holds(request->removed, request->removed_words, ordinal)) {
    return 0;
  }
  return !request->has_filter || keyword_holds(request->filter, request->filter_words, ordinal);
}

static inline int keyword_searchable(const keyword_pass *pass, uint32_t field) {
  return field < pass->field_count && pass->request->searchable[field] != 0;
}

static inline double keyword_bm25(const keyword_pass *pass, double idf, double frequency, double length,
                                  uint32_t field) {
  double average = pass->averages[field];
  double bm25 = 0;
  if (average != 0) {
    double saturation = pass->k1s[field];
    double length_weight = pass->bs[field];
    double top = frequency * (saturation + 1);
    double bottom = frequency + (saturation * ((1 - length_weight) + ((length_weight * length) / average)));
    bm25 = bottom == 0 ? 0 : idf * (top / bottom);
  }
  return bm25 * pass->boosts[field];
}

static inline double keyword_row_score(const keyword_pass *pass, double idf, double frequency, uint32_t field,
                                       uint32_t ordinal) {
  const narsil_keyword_column *column = &pass->request->lengths[field];
  uint32_t stored = column->values != NULL && ordinal < column->length ? column->values[ordinal] : 0;
  return keyword_bm25(pass, idf, frequency, stored > 0 ? (double)stored : pass->averages[field], field);
}

#endif
