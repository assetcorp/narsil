#ifndef NARSIL_SORT_SELECT_INTERNAL_H
#define NARSIL_SORT_SELECT_INTERNAL_H

#include "../../include/narsil_sort_select.h"

#include <stddef.h>
#include <stdint.h>

enum { SORT_WORD_BITS = 32, SORT_WORD_SHIFT = 5, SORT_WORD_MASK = 31 };

static inline int sort_marked(const uint32_t *bits, uint32_t ordinal) {
  return (bits[ordinal >> SORT_WORD_SHIFT] & (UINT32_C(1) << (ordinal & SORT_WORD_MASK))) != 0;
}

int sort_select_valid(const narsil_sort_select_request *request, uint32_t *count);
int sort_select_ordinal_valid(const narsil_sort_select_request *request, uint32_t ordinal);
int32_t sort_column_rank(const narsil_sort_column *column, uint32_t ordinal);
int sort_select_compare(const narsil_sort_select_request *request, uint32_t left, uint32_t right);
int sort_select_anchor_compare(const narsil_sort_select_request *request, uint32_t ordinal);
size_t sort_select_start(const narsil_sort_select_request *request);

#endif
