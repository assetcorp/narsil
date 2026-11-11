#include "../../include/narsil_facets.h"

#include "../../include/narsil_core.h"
#include "../regions.h"

#include <stddef.h>
#include <stdint.h>

static uint64_t count_matches(const uint32_t *bits, size_t words, const uint32_t *matched) {
  uint64_t total = 0;
  for (size_t word = 0; word < words; word++) { total += (uint32_t)__builtin_popcount(bits[word] & matched[word]); }
  return total;
}

narsil_status narsil_boolean_facet(const narsil_boolean_index *index, const uint32_t *matched, size_t matched_words,
                                   uint32_t *counts, size_t count_capacity) {
  if (index == NULL || index->true_words == 0 || index->false_words == 0 || matched_words == 0) {
    return NARSIL_INVALID_ARGUMENT;
  }
  memory_region inputs[4];
  memory_region output;
  if (!region_of(index->true_bits, index->true_words, sizeof *index->true_bits, &inputs[0]) ||
      !region_of(index->false_bits, index->false_words, sizeof *index->false_bits, &inputs[1]) ||
      !region_of(matched, matched_words, sizeof *matched, &inputs[2]) ||
      !region_of(index, 1, sizeof *index, &inputs[3]) || !region_of(counts, count_capacity, sizeof *counts, &output)) {
    return NARSIL_INVALID_ARGUMENT;
  }
  for (size_t input = 0; input < sizeof inputs / sizeof inputs[0]; input++) {
    if (overlaps(inputs[input], output)) { return NARSIL_INVALID_ARGUMENT; }
  }
  if (count_capacity < 2) { return NARSIL_NEEDS_ROOM; }
  size_t true_words = index->true_words < matched_words ? index->true_words : matched_words;
  size_t false_words = index->false_words < matched_words ? index->false_words : matched_words;
  uint64_t true_count = count_matches(index->true_bits, true_words, matched);
  uint64_t false_count = count_matches(index->false_bits, false_words, matched);
  if (true_count > UINT32_MAX || false_count > UINT32_MAX) { return NARSIL_INVALID_ARGUMENT; }
  counts[0] = (uint32_t)true_count;
  counts[1] = (uint32_t)false_count;
  return NARSIL_OK;
}
