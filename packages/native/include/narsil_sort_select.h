#ifndef NARSIL_SORT_SELECT_H
#define NARSIL_SORT_SELECT_H

#include "narsil_core.h"
#include "narsil_sort_order.h"

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
  const narsil_sort_column *columns;
  size_t column_count;
  const uint8_t *directions;
  size_t direction_count;
  const uint32_t *filter;
  size_t filter_words;
  const uint32_t *live;
  size_t live_words;
  uint32_t limit;
  const int32_t *anchor_ranks;
  size_t anchor_rank_count;
  const narsil_sort_values *anchor_values;
  uint32_t *output;
  size_t output_capacity;
} narsil_sort_select_request;

narsil_status narsil_sort_select(narsil_workspace *workspace, const narsil_sort_select_request *request,
                                 uint32_t *count);

#ifdef __cplusplus
}
#endif

#endif
