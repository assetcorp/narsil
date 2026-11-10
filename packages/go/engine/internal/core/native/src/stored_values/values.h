#ifndef NARSIL_STORED_VALUE_OPERATIONS_H
#define NARSIL_STORED_VALUE_OPERATIONS_H

#include "../../include/narsil_stored_values.h"
#include "../regions.h"

enum { STORED_VALUE_REGIONS = 8 };
enum { STORED_ABSENT, STORED_SCALAR, STORED_ARRAY };
enum { STORED_NULL, STORED_FALSE, STORED_TRUE, STORED_NUMBER, STORED_STRING, STORED_OTHER };

int stored_value_regions(const narsil_stored_values *values, memory_region regions[STORED_VALUE_REGIONS]);
int stored_value_valid(const narsil_stored_values *values, uint32_t ordinal);
int stored_element_valid(const narsil_stored_values *values, uint32_t index);
int stored_element_compare(const narsil_stored_values *values, uint32_t left, uint32_t right);
int stored_value_compare(const narsil_stored_values *values, uint32_t left, uint32_t right);

#endif
