#include "../../include/narsil_facets.h"

#include "../../include/narsil_core.h"
#include "../regions.h"
#include "numeric.h"
#include "scratch.h"

#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

enum { OUTPUT_REGIONS = 3 };

static int valid_outputs(const narsil_numeric_facet_input *input, const narsil_number_facet_output *output,
                         uint32_t *count) {
  if (output == NULL || count == NULL) { return 0; }
  memory_region outputs[OUTPUT_REGIONS];
  memory_region descriptor;
  if (!region_of(output->values, output->value_capacity, sizeof *output->values, &outputs[0]) ||
      !region_of(output->counts, output->count_capacity, sizeof *output->counts, &outputs[1]) ||
      !region_of(count, 1, sizeof *count, &outputs[2]) || !region_of(output, 1, sizeof *output, &descriptor) ||
      !numeric_facet_regions(input, outputs, OUTPUT_REGIONS)) {
    return 0;
  }
  for (size_t at = 0; at < OUTPUT_REGIONS; at++) {
    if (overlaps(outputs[at], descriptor)) { return 0; }
  }
  return 1;
}

narsil_status narsil_number_facet(narsil_workspace *workspace, const narsil_numeric_facet_input *input,
                                  const narsil_number_facet_output *output, uint32_t *count) {
  if (workspace == NULL || !valid_outputs(input, output, count)) { return NARSIL_INVALID_ARGUMENT; }
  facet_scratch *scratch = workspace_facet_scratch(workspace);
  facet_matches matches = {input->ordinals, input->matched, input->matched_words};
  narsil_status status =
      reserve_facet_scratch(scratch, (uint32_t)input->count, facet_bitmap_words(input->matched_words));
  if (status != NARSIL_OK) { return status; }
  uint32_t buckets = 0;
  for (size_t start = 0; start < input->count;) {
    double value = input->values[start];
    size_t end = start + 1;
    while (end < input->count && input->values[end] == value) { end++; }
    if (!isnan(value)) {
      uint32_t matched = count_facet_span(matches, scratch, start, end);
      if (matched > 0) {
        scratch->values[buckets] = value == 0 ? 0 : value;
        scratch->counts[buckets++] = matched;
      }
    }
    start = end;
  }
  if (buckets > output->value_capacity || buckets > output->count_capacity) { return NARSIL_NEEDS_ROOM; }
  if (buckets > 0) {
    memcpy(output->values, scratch->values, (size_t)buckets * sizeof *output->values);
    memcpy(output->counts, scratch->counts, (size_t)buckets * sizeof *output->counts);
  }
  *count = buckets;
  return NARSIL_OK;
}
