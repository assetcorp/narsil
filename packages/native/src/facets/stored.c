#include "../../include/narsil_facets.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_stored_values.h"
#include "../regions.h"
#include "../stored_values/values.h"
#include "scratch.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

enum { EXTRA_INPUT_REGIONS = 3, OUTPUT_REGIONS = 3, WORD_SHIFT = 5, WORD_MASK = 31 };

static int valid_request(const narsil_stored_values *values, const uint32_t *matched, size_t matched_words,
                         const narsil_value_facet_output *output, uint32_t *count) {
  if (values == NULL || output == NULL || count == NULL || matched_words == 0) { return 0; }
  memory_region inputs[STORED_VALUE_REGIONS + EXTRA_INPUT_REGIONS];
  memory_region outputs[OUTPUT_REGIONS];
  if (!stored_value_regions(values, inputs) ||
      !region_of(matched, matched_words, sizeof *matched, &inputs[STORED_VALUE_REGIONS]) ||
      !region_of(values, 1, sizeof *values, &inputs[STORED_VALUE_REGIONS + 1]) ||
      !region_of(output, 1, sizeof *output, &inputs[STORED_VALUE_REGIONS + 2]) ||
      !region_of(output->values, output->value_capacity, sizeof *output->values, &outputs[0]) ||
      !region_of(output->counts, output->count_capacity, sizeof *output->counts, &outputs[1]) ||
      !region_of(count, 1, sizeof *count, &outputs[2])) {
    return 0;
  }
  for (size_t target = 0; target < OUTPUT_REGIONS; target++) {
    for (size_t source = 0; source < STORED_VALUE_REGIONS + EXTRA_INPUT_REGIONS; source++) {
      if (overlaps(outputs[target], inputs[source])) { return 0; }
    }
    for (size_t prior = 0; prior < target; prior++) {
      if (overlaps(outputs[target], outputs[prior])) { return 0; }
    }
  }
  return 1;
}

static narsil_status collect(const narsil_stored_values *values, const uint32_t *matched, size_t words,
                             facet_scratch *scratch) {
  for (size_t ordinal = 0; ordinal < values->shape_count; ordinal++) {
    size_t word = ordinal >> WORD_SHIFT;
    if (word >= words || (matched[word] & (UINT32_C(1) << (ordinal & WORD_MASK))) == 0) { continue; }
    uint8_t shape = values->shapes[ordinal];
    uint32_t start = values->starts[ordinal];
    uint32_t end = values->starts[ordinal + 1];
    if (shape == STORED_ABSENT || shape > STORED_ARRAY || start > end || end > values->kind_count ||
        (shape == STORED_SCALAR && end - start != 1)) {
      continue;
    }
    for (uint32_t at = start; at < end; at++) {
      uint8_t kind = values->kinds[at];
      if (kind < STORED_FALSE || kind > STORED_STRING || !stored_element_valid(values, at)) { continue; }
      if (scratch->counts[at] == UINT32_MAX) { return NARSIL_INVALID_ARGUMENT; }
      scratch->counts[at]++;
    }
  }
  return NARSIL_OK;
}

static void order_values(const narsil_stored_values *values, facet_scratch *scratch, size_t count) {
  uint32_t *ordered = scratch->positions;
  uint32_t *spare = scratch->spare;
  for (size_t width = 1; width < count; width *= 2) {
    for (size_t start = 0; start < count; start += width * 2) {
      size_t middle = start + width < count ? start + width : count;
      size_t end = middle + width < count ? middle + width : count;
      size_t left = start;
      size_t right = middle;
      for (size_t at = start; at < end; at++) {
        if (right == end || (left < middle && stored_element_compare(values, ordered[left], ordered[right]) <= 0)) {
          spare[at] = ordered[left++];
        } else {
          spare[at] = ordered[right++];
        }
      }
    }
    uint32_t *swap = ordered;
    ordered = spare;
    spare = swap;
  }
  if (ordered != scratch->positions && count > 0) { memcpy(scratch->positions, ordered, count * sizeof *ordered); }
}

narsil_status narsil_value_facet(narsil_workspace *workspace, const narsil_stored_values *values,
                                 const uint32_t *matched, size_t matched_words, const narsil_value_facet_output *output,
                                 uint32_t *count) {
  if (workspace == NULL || !valid_request(values, matched, matched_words, output, count)) {
    return NARSIL_INVALID_ARGUMENT;
  }
  facet_scratch *scratch = workspace_facet_scratch(workspace);
  narsil_status status = reserve_facet_scratch(scratch, (uint32_t)values->kind_count, 0);
  if (status != NARSIL_OK) { return status; }
  if (values->kind_count > 0) { memset(scratch->counts, 0, values->kind_count * sizeof *scratch->counts); }
  status = collect(values, matched, matched_words, scratch);
  if (status != NARSIL_OK) { return status; }
  uint32_t selected = 0;
  for (size_t at = 0; at < values->kind_count; at++) {
    if (scratch->counts[at] > 0) { scratch->positions[selected++] = (uint32_t)at; }
  }
  order_values(values, scratch, selected);
  uint32_t buckets = 0;
  for (size_t start = 0; start < selected;) {
    uint32_t first = scratch->positions[start];
    uint64_t total = scratch->counts[first];
    size_t end = start + 1;
    while (end < selected && stored_element_compare(values, first, scratch->positions[end]) == 0) {
      total += scratch->counts[scratch->positions[end++]];
      if (total > UINT32_MAX) { return NARSIL_INVALID_ARGUMENT; }
    }
    scratch->positions[buckets++] = first;
    scratch->counts[first] = (uint32_t)total;
    start = end;
  }
  if (buckets > output->value_capacity || buckets > output->count_capacity) { return NARSIL_NEEDS_ROOM; }
  for (uint32_t at = 0; at < buckets; at++) {
    uint32_t first = scratch->positions[at];
    output->values[at] = first;
    output->counts[at] = scratch->counts[first];
  }
  *count = buckets;
  return NARSIL_OK;
}
