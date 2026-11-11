#ifndef NARSIL_FACETS_H
#define NARSIL_FACETS_H

#include "narsil_core.h"
#include "narsil_stored_values.h"

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
  const uint32_t *true_bits;
  size_t true_words;
  const uint32_t *false_bits;
  size_t false_words;
} narsil_boolean_index;

typedef struct {
  const double *values;
  size_t count;
  const uint32_t *ordinals;
  size_t ordinal_count;
  const uint32_t *matched;
  size_t matched_words;
} narsil_numeric_facet_input;

typedef struct {
  double *values;
  size_t value_capacity;
  uint32_t *counts;
  size_t count_capacity;
} narsil_number_facet_output;

typedef struct {
  uint32_t *values;
  size_t value_capacity;
  uint32_t *counts;
  size_t count_capacity;
} narsil_value_facet_output;

narsil_status narsil_stored_range_facet(const narsil_stored_values *values, const uint32_t *matched,
                                        size_t matched_words, const double *ranges, size_t range_length,
                                        uint32_t *counts, size_t count_capacity);

narsil_status narsil_value_facet(narsil_workspace *workspace, const narsil_stored_values *values,
                                 const uint32_t *matched, size_t matched_words, const narsil_value_facet_output *output,
                                 uint32_t *count);

narsil_status narsil_enum_facet(narsil_workspace *workspace, const uint32_t *offsets, size_t offset_count,
                                const uint32_t *postings, size_t posting_count, const uint32_t *matched,
                                size_t matched_words, uint32_t *counts, size_t count_capacity);

narsil_status narsil_number_facet(narsil_workspace *workspace, const narsil_numeric_facet_input *input,
                                  const narsil_number_facet_output *output, uint32_t *count);
narsil_status narsil_range_facet(narsil_workspace *workspace, const narsil_numeric_facet_input *input,
                                 const double *ranges, size_t range_length, uint32_t *counts, size_t count_capacity);

narsil_status narsil_boolean_facet(const narsil_boolean_index *index, const uint32_t *matched, size_t matched_words,
                                   uint32_t *counts, size_t count_capacity);

#ifdef __cplusplus
}
#endif

#endif
