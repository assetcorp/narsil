#ifndef NARSIL_FILTER_INTERNAL_H
#define NARSIL_FILTER_INTERNAL_H

#include "../../include/narsil_filters.h"
#include "../regions.h"
#include "geo.h"

#include <stddef.h>
#include <stdint.h>

typedef struct {
  uint32_t *words;
  size_t capacity;
  filter_geo_scratch geo;
} filter_scratch;

filter_scratch *workspace_filter_scratch(narsil_workspace *workspace);
narsil_status reserve_filter_scratch(filter_scratch *scratch, size_t words);
int filter_regions_valid(const narsil_filter_program *program, memory_region output);
int filter_plan_valid(const narsil_filter_program *program, size_t *maximum_depth);
void filter_test(const narsil_filter_program *program, const narsil_filter_field *field, uint32_t operator,
                 uint32_t operand, uint32_t *into, uint32_t *scratch, filter_geo_scratch *geo);
void filter_enum_test(const narsil_filter_program *program, const narsil_filter_field *field, uint32_t operator,
                      uint32_t operand, uint32_t *into);
void filter_geo_test(const narsil_filter_program *program, const narsil_filter_field *field, uint32_t operand,
                     uint32_t *into, filter_geo_scratch *scratch, uint32_t operator);

static inline void filter_set(uint32_t *into, size_t words, uint32_t ordinal) {
  size_t word = ordinal >> 5;
  if (word < words) { into[word] |= UINT32_C(1) << (ordinal & 31); }
}

#endif
