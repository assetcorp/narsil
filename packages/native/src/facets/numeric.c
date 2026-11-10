#include "numeric.h"

#include "../../include/narsil_facets.h"
#include "../regions.h"
#include "scratch.h"

#include <stddef.h>
#include <stdint.h>

enum { WORD_BITS = 32, WORD_SHIFT = 5, WORD_MASK = 31, INPUT_REGIONS = 4 };

int numeric_facet_regions(const narsil_numeric_facet_input *input, const memory_region *outputs, size_t output_count) {
  if (input == NULL || input->count > UINT32_MAX || input->ordinal_count != input->count || input->matched_words == 0) {
    return 0;
  }
  memory_region regions[INPUT_REGIONS];
  if (!region_of(input->values, input->count, sizeof *input->values, &regions[0]) ||
      !region_of(input->ordinals, input->ordinal_count, sizeof *input->ordinals, &regions[1]) ||
      !region_of(input->matched, input->matched_words, sizeof *input->matched, &regions[2]) ||
      !region_of(input, 1, sizeof *input, &regions[3])) {
    return 0;
  }
  for (size_t target = 0; target < output_count; target++) {
    for (size_t source = 0; source < INPUT_REGIONS; source++) {
      if (overlaps(outputs[target], regions[source])) { return 0; }
    }
    for (size_t prior = 0; prior < target; prior++) {
      if (overlaps(outputs[target], outputs[prior])) { return 0; }
    }
  }
  return 1;
}

size_t facet_bitmap_words(size_t matched_words) {
  size_t maximum = ((size_t)UINT32_MAX / WORD_BITS) + 1;
  return matched_words < maximum ? matched_words : maximum;
}

size_t numeric_lower(const narsil_numeric_facet_input *input, double value) {
  size_t low = 0;
  size_t high = input->count;
  while (low < high) {
    size_t middle = low + ((high - low) / 2);
    if (input->values[middle] < value) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

uint32_t count_facet_span(facet_matches matches, facet_scratch *scratch, size_t start, size_t end) {
  uint32_t count = 0;
  for (size_t at = start; at < end; at++) {
    uint32_t ordinal = matches.ordinals[at];
    size_t word = ordinal >> WORD_SHIFT;
    if (word >= matches.words) { continue; }
    uint32_t bit = UINT32_C(1) << (ordinal & WORD_MASK);
    if ((matches.matched[word] & bit) != 0 && (scratch->seen[word] & bit) == 0) {
      count++;
      scratch->seen[word] |= bit;
    }
  }
  for (size_t at = start; at < end; at++) {
    uint32_t ordinal = matches.ordinals[at];
    size_t word = ordinal >> WORD_SHIFT;
    if (word < matches.words) { scratch->seen[word] &= ~(UINT32_C(1) << (ordinal & WORD_MASK)); }
  }
  return count;
}
