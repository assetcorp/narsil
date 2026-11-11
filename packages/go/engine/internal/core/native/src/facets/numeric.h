#ifndef NARSIL_NUMERIC_FACET_INTERNAL_H
#define NARSIL_NUMERIC_FACET_INTERNAL_H

#include "../../include/narsil_facets.h"
#include "../regions.h"
#include "scratch.h"

#include <stddef.h>
#include <stdint.h>

int numeric_facet_regions(const narsil_numeric_facet_input *input, const memory_region *outputs, size_t output_count);
typedef struct {
  const uint32_t *ordinals;
  const uint32_t *matched;
  size_t words;
} facet_matches;

size_t facet_bitmap_words(size_t matched_words);
size_t numeric_lower(const narsil_numeric_facet_input *input, double value);
uint32_t count_facet_span(facet_matches matches, facet_scratch *scratch, size_t start, size_t end);

#endif
