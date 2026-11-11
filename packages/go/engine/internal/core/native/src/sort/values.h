#ifndef NARSIL_SORT_VALUES_INTERNAL_H
#define NARSIL_SORT_VALUES_INTERNAL_H

#include "../../include/narsil_sort_order.h"
#include "../regions.h"

enum { SORT_VALUE_REGIONS = 5 };

int sort_value_regions(const narsil_sort_values *values, memory_region *regions);
int sort_value_at_valid(const narsil_sort_values *values, uint32_t ordinal);
int sort_values_compare(const narsil_sort_values *values, uint32_t left, uint32_t right);
int sort_values_compare_between(const narsil_sort_values *lhs_values, uint32_t left,
                                const narsil_sort_values *rhs_values, uint32_t right);

#endif
