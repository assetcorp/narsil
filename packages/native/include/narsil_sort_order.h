#ifndef NARSIL_SORT_ORDER_H
#define NARSIL_SORT_ORDER_H

#include "narsil_core.h"

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
  const uint8_t *kinds;
  size_t count;
  const double *numbers;
  size_t number_count;
  const uint32_t *text_start;
  size_t text_start_count;
  const uint32_t *text_length;
  size_t text_length_count;
  const uint16_t *units;
  size_t unit_count;
} narsil_sort_values;

typedef struct {
  uint8_t *kinds;
  size_t capacity;
  double *numbers;
  size_t number_capacity;
  uint32_t *text_start;
  size_t text_start_capacity;
  uint32_t *text_length;
  size_t text_length_capacity;
  uint16_t *units;
  size_t unit_capacity;
} narsil_sort_values_output;

typedef struct {
  narsil_sort_values_output values;
  int32_t *ranks;
  size_t rank_capacity;
  uint32_t *ordered;
  size_t ordered_capacity;
  uint32_t *dirty;
  size_t dirty_capacity;
  uint32_t *counts;
  size_t count_capacity;
} narsil_sort_order_output;

typedef struct {
  narsil_sort_values current;
  narsil_sort_values values;
  const int32_t *ranks;
  size_t rank_count;
  const uint32_t *ordered;
  size_t ordered_count;
  const uint32_t *dirty;
  size_t dirty_words;
} narsil_sort_column;

typedef struct {
  const uint16_t *units;
  size_t length;
  uint32_t present;
  uint32_t inclusive;
} narsil_sort_bound;

typedef struct {
  narsil_sort_bound lower;
  narsil_sort_bound upper;
  const uint32_t *live;
  size_t live_words;
  uint32_t *output;
  size_t output_words;
} narsil_text_range_request;

narsil_status narsil_text_range(const narsil_sort_column *column, const narsil_text_range_request *request);

narsil_status narsil_build_sort_order(narsil_workspace *workspace, const narsil_sort_values *current,
                                      const uint32_t *live, size_t live_words, narsil_sort_order_output *output);

#ifdef __cplusplus
}
#endif

#endif
