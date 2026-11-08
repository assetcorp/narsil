#include "../../include/narsil_facets.h"

#include "../../include/narsil_core.h"
#include "../regions.h"
#include "numeric.h"
#include "scratch.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

narsil_status narsil_enum_facet(narsil_workspace *workspace, const uint32_t *offsets, size_t offset_count,
                                const uint32_t *postings, size_t posting_count, const uint32_t *matched,
                                size_t matched_words, uint32_t *counts, size_t count_capacity) {
  memory_region inputs[3];
  memory_region output;
  if (workspace == NULL || offset_count == 0 || offset_count - 1 > UINT32_MAX || posting_count > UINT32_MAX ||
      matched_words == 0 || !region_of(offsets, offset_count, sizeof *offsets, &inputs[0]) ||
      !region_of(postings, posting_count, sizeof *postings, &inputs[1]) ||
      !region_of(matched, matched_words, sizeof *matched, &inputs[2]) ||
      !region_of(counts, count_capacity, sizeof *counts, &output)) {
    return NARSIL_INVALID_ARGUMENT;
  }
  for (size_t at = 0; at < 3; at++) {
    if (overlaps(output, inputs[at])) { return NARSIL_INVALID_ARGUMENT; }
  }
  size_t count = offset_count - 1;
  if (count_capacity < count) { return NARSIL_NEEDS_ROOM; }
  if (count == 0) { return NARSIL_OK; }
  facet_scratch *scratch = workspace_facet_scratch(workspace);
  facet_matches matches = {postings, matched, matched_words};
  narsil_status status = reserve_facet_scratch(scratch, (uint32_t)count, facet_bitmap_words(matched_words));
  if (status != NARSIL_OK) { return status; }
  for (size_t at = 0; at < count; at++) {
    size_t start = offsets[at];
    size_t end = offsets[at + 1];
    scratch->counts[at] = start > end || end > posting_count ? 0 : count_facet_span(matches, scratch, start, end);
  }
  memcpy(counts, scratch->counts, count * sizeof *counts);
  return NARSIL_OK;
}
