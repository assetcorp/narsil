#include "../../include/narsil_facets.h"

#include "../../include/narsil_core.h"
#include "../regions.h"
#include "numeric.h"
#include "scratch.h"

#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

narsil_status narsil_range_facet(narsil_workspace *workspace, const narsil_numeric_facet_input *input,
                                 const double *ranges, size_t range_length, uint32_t *counts, size_t count_capacity) {
  memory_region output;
  memory_region bounds;
  if (workspace == NULL || range_length % 2 != 0 || range_length / 2 > UINT32_MAX ||
      !region_of(counts, count_capacity, sizeof *counts, &output) ||
      !region_of(ranges, range_length, sizeof *ranges, &bounds) || overlaps(output, bounds) ||
      !numeric_facet_regions(input, &output, 1)) {
    return NARSIL_INVALID_ARGUMENT;
  }
  uint32_t count = (uint32_t)(range_length / 2);
  if (count_capacity < count) { return NARSIL_NEEDS_ROOM; }
  if (count == 0) { return NARSIL_OK; }
  facet_scratch *scratch = workspace_facet_scratch(workspace);
  facet_matches matches = {input->ordinals, input->matched, input->matched_words};
  narsil_status status = reserve_facet_scratch(scratch, count, facet_bitmap_words(input->matched_words));
  if (status != NARSIL_OK) { return status; }
  for (uint32_t at = 0; at < count; at++) {
    double from = ranges[(size_t)at * 2];
    double until = ranges[((size_t)at * 2) + 1];
    if (isnan(from) || isnan(until)) {
      scratch->counts[at] = 0;
    } else {
      scratch->counts[at] = count_facet_span(matches, scratch, numeric_lower(input, from), numeric_lower(input, until));
    }
  }
  memcpy(counts, scratch->counts, (size_t)count * sizeof *counts);
  return NARSIL_OK;
}
