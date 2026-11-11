#include "select.h"

#include "../../include/narsil_sort.h"
#include "../../include/narsil_sort_order.h"
#include "../../include/narsil_sort_select.h"
#include "values.h"

#include <stddef.h>
#include <stdint.h>

size_t sort_select_start(const narsil_sort_select_request *request) {
  if (request->anchor_values == NULL) { return 0; }
  const narsil_sort_column *column = &request->columns[0];
  int32_t anchor = request->anchor_ranks[0];
  if (anchor == -1) { return column->ordered_count; }
  size_t low = 0;
  size_t high = column->ordered_count;
  while (low < high) {
    size_t middle = low + ((high - low) / 2);
    uint32_t ordinal = column->ordered[middle];
    if (ordinal >= column->current.count || ordinal >= column->rank_count) { return SIZE_MAX; }
    int32_t rank = column->ranks[ordinal];
    if (rank < 2 || (rank & 1) != 0 || (uint32_t)rank / 2 > column->values.count) { return SIZE_MAX; }
    if (rank < anchor || (request->directions[0] && rank == anchor)) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return request->directions[0] ? column->ordered_count - low : low;
}

int32_t sort_column_rank(const narsil_sort_column *column, uint32_t ordinal) {
  if (!sort_marked(column->dirty, ordinal)) { return ordinal < column->rank_count ? column->ranks[ordinal] : -1; }
  if (column->current.kinds[ordinal] == NARSIL_SORT_MISSING) { return -1; }
  size_t low = 0;
  size_t high = column->values.count;
  while (low < high) {
    size_t middle = low + ((high - low) / 2);
    int comparison = sort_values_compare_between(&column->values, (uint32_t)middle, &column->current, ordinal);
    if (comparison == 0) { return (int32_t)((middle + 1) * 2); }
    if (comparison < 0) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return (int32_t)((low * 2) + 1);
}

static int compare_rank(int32_t left, int32_t right) {
  if (left == right) { return 0; }
  if (left == -1) { return 1; }
  if (right == -1) { return -1; }
  return left < right ? -1 : 1;
}

int sort_select_compare(const narsil_sort_select_request *request, uint32_t left, uint32_t right) {
  for (size_t field = 0; field < request->column_count; field++) {
    const narsil_sort_column *column = &request->columns[field];
    int32_t lhs = sort_column_rank(column, left);
    int32_t rhs = sort_column_rank(column, right);
    int order = compare_rank(lhs, rhs);
    if (lhs != -1 && rhs != -1 && request->directions[field]) { order = -order; }
    if (order != 0) { return order; }
    if (lhs != -1 && (lhs & 1) != 0) {
      order = sort_values_compare(&column->current, left, right);
      if (order != 0) { return request->directions[field] ? -order : order; }
    }
  }
  return 0;
}

int sort_select_anchor_compare(const narsil_sort_select_request *request, uint32_t ordinal) {
  if (request->anchor_values == NULL) { return 0; }
  for (size_t field = 0; field < request->column_count; field++) {
    const narsil_sort_column *column = &request->columns[field];
    int32_t rank = sort_column_rank(column, ordinal);
    int32_t anchor = request->anchor_ranks[field];
    int order = compare_rank(rank, anchor);
    if (rank != -1 && anchor != -1 && request->directions[field]) { order = -order; }
    if (order != 0) { return order; }
    if (rank != -1 && (rank & 1) != 0) {
      order = sort_values_compare_between(&column->current, ordinal, request->anchor_values, (uint32_t)field);
      if (order != 0) { return request->directions[field] ? -order : order; }
    }
  }
  return 0;
}
