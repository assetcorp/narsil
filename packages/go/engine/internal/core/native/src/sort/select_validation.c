#include "select.h"

#include "../../include/narsil_sort.h"
#include "../../include/narsil_sort_order.h"
#include "../../include/narsil_sort_select.h"
#include "../regions.h"
#include "values.h"

#include <stddef.h>
#include <stdint.h>

static int input_region(const void *pointer, size_t count, size_t width, const memory_region *outputs) {
  memory_region region;
  return region_of(pointer, count, width, &region) && !overlaps(region, outputs[0]) && !overlaps(region, outputs[1]);
}

static int value_regions(const narsil_sort_values *values, const memory_region *outputs) {
  memory_region regions[SORT_VALUE_REGIONS];
  if (!sort_value_regions(values, regions)) { return 0; }
  for (size_t at = 0; at < SORT_VALUE_REGIONS; at++) {
    if (overlaps(regions[at], outputs[0]) || overlaps(regions[at], outputs[1])) { return 0; }
  }
  return 1;
}

static int valid_column(const narsil_sort_column *column, size_t count, size_t words, const memory_region *outputs) {
  if (column->current.count != count || column->values.count > (uint32_t)INT32_MAX / 2 || column->rank_count > count ||
      column->ordered_count > count || column->dirty_words < words || !value_regions(&column->current, outputs) ||
      !value_regions(&column->values, outputs) ||
      !input_region(column->ranks, column->rank_count, sizeof *column->ranks, outputs) ||
      !input_region(column->ordered, column->ordered_count, sizeof *column->ordered, outputs) ||
      !input_region(column->dirty, column->dirty_words, sizeof *column->dirty, outputs)) {
    return 0;
  }
  for (uint32_t at = 0; at < column->values.count; at++) {
    if (!sort_value_at_valid(&column->values, at) || column->values.kinds[at] == NARSIL_SORT_MISSING) { return 0; }
  }
  return 1;
}

int sort_select_valid(const narsil_sort_select_request *request, uint32_t *count) {
  if (request == NULL || count == NULL || request->column_count == 0 || request->column_count > UINT32_MAX ||
      request->direction_count != request->column_count) {
    return 0;
  }
  memory_region outputs[2];
  if (!region_of(request->output, request->output_capacity, sizeof *request->output, &outputs[0]) ||
      !region_of(count, 1, sizeof *count, &outputs[1]) || overlaps(outputs[0], outputs[1]) ||
      !input_region(request, 1, sizeof *request, outputs) ||
      !input_region(request->columns, request->column_count, sizeof *request->columns, outputs) ||
      !input_region(request->directions, request->direction_count, sizeof *request->directions, outputs) ||
      !input_region(request->filter, request->filter_words, sizeof *request->filter, outputs) ||
      !input_region(request->live, request->live_words, sizeof *request->live, outputs) ||
      !input_region(request->anchor_ranks, request->anchor_rank_count, sizeof *request->anchor_ranks, outputs)) {
    return 0;
  }
  size_t ordinals = request->columns[0].current.count;
  size_t words = ordinals == 0 ? 1 : ((ordinals - 1) / SORT_WORD_BITS) + 1;
  if (ordinals > UINT32_MAX || request->filter_words < words || request->live_words < words) { return 0; }
  if (request->anchor_values == NULL) {
    if (request->anchor_ranks != NULL || request->anchor_rank_count != 0) { return 0; }
  } else if (request->anchor_rank_count != request->column_count ||
             !input_region(request->anchor_values, 1, sizeof *request->anchor_values, outputs) ||
             !value_regions(request->anchor_values, outputs) ||
             request->anchor_values->count != request->column_count) {
    return 0;
  }
  for (size_t field = 0; field < request->column_count; field++) {
    const narsil_sort_column *column = &request->columns[field];
    if (request->directions[field] > 1 || !valid_column(column, ordinals, words, outputs)) { return 0; }
    if (request->anchor_values != NULL) {
      int32_t rank = request->anchor_ranks[field];
      if (!sort_value_at_valid(request->anchor_values, (uint32_t)field) || rank < -1 || rank == 0 ||
          (rank > 0 && (uint32_t)rank > (column->values.count * 2) + 1)) {
        return 0;
      }
    }
  }
  return 1;
}

int sort_select_ordinal_valid(const narsil_sort_select_request *request, uint32_t ordinal) {
  for (size_t field = 0; field < request->column_count; field++) {
    const narsil_sort_column *column = &request->columns[field];
    if (ordinal >= column->current.count || !sort_value_at_valid(&column->current, ordinal)) { return 0; }
    if (sort_marked(column->dirty, ordinal) || ordinal >= column->rank_count) { continue; }
    int32_t rank = column->ranks[ordinal];
    if (rank != -1 && (rank < 2 || (rank & 1) != 0 || (uint32_t)rank / 2 > column->values.count)) { return 0; }
  }
  return 1;
}
