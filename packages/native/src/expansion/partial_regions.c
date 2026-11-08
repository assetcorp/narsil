#include "internal.h"

#include "../../include/narsil_expansion.h"
#include "../regions.h"
#include "../segments/regions.h"

#include <stddef.h>
#include <stdint.h>

static int frozen_runs(const segment_regions *outputs, const narsil_frozen_runs *runs, int growing) {
  if (runs->offset_count == 0) {
    return runs->point_count == 0 && runs->member_count == 0 && runs->points == NULL && runs->offsets == NULL &&
           runs->members == NULL;
  }
  if (growing || runs->point_count % PARTIAL_RUN_POINTS != 0 || runs->point_count / PARTIAL_RUN_POINTS > UINT32_MAX ||
      runs->offset_count != (runs->point_count / PARTIAL_RUN_POINTS) + 1 || runs->member_count > UINT32_MAX ||
      (uintptr_t)runs->points % _Alignof(uint32_t) != 0 || (uintptr_t)runs->offsets % _Alignof(uint32_t) != 0 ||
      (uintptr_t)runs->members % _Alignof(uint32_t) != 0) {
    return 0;
  }
  return segment_region_input(outputs, runs->points, runs->point_count, sizeof *runs->points) &&
         segment_region_input(outputs, runs->offsets, runs->offset_count, sizeof *runs->offsets) &&
         segment_region_input(outputs, runs->members, runs->member_count, sizeof *runs->members);
}

int partial_regions(const narsil_partial_request *request, const narsil_partial_output *output, uint32_t *count) {
  if (request == NULL || (uintptr_t)request % _Alignof(narsil_partial_request) != 0 || output == NULL ||
      (uintptr_t)output % _Alignof(narsil_partial_output) != 0 || request->segment_count > UINT32_MAX ||
      request->word_count > UINT32_MAX || request->word_count == SIZE_MAX ||
      (uintptr_t)request->segments % _Alignof(narsil_expansion_segment) != 0 ||
      (uintptr_t)request->runs % _Alignof(narsil_frozen_runs) != 0 ||
      (uintptr_t)request->words % _Alignof(narsil_partial_word) != 0) {
    return 0;
  }
  segment_regions regions = {0};
  const narsil_expansion_output *added = &output->additions;
  if (!segment_region_write(&regions, added->segments, added->segment_capacity, sizeof *added->segments) ||
      !segment_region_write(&regions, added->tokens, added->token_capacity, sizeof *added->tokens) ||
      !segment_region_write(&regions, added->factors, added->factor_capacity, sizeof *added->factors) ||
      !segment_region_write(&regions, output->starts, output->start_capacity, sizeof *output->starts) ||
      !segment_region_write(&regions, count, 1, sizeof *count) ||
      !segment_region_input(&regions, request, 1, sizeof *request) ||
      !segment_region_input(&regions, output, 1, sizeof *output) ||
      !segment_region_input(&regions, request->segments, request->segment_count, sizeof *request->segments) ||
      !segment_region_input(&regions, request->runs, request->segment_count, sizeof *request->runs) ||
      !segment_region_input(&regions, request->words, request->word_count, sizeof *request->words)) {
    return 0;
  }
  for (size_t at = 0; at < regions.write_count; at++) {
    for (size_t before = 0; before < at; before++) {
      if (overlaps(regions.writes[at], regions.writes[before])) { return 0; }
    }
  }
  for (size_t at = 0; at < request->segment_count; at++) {
    if (!expansion_source_regions(request->segments + at, &regions) ||
        !frozen_runs(&regions, request->runs + at, request->segments[at].growing != NULL)) {
      return 0;
    }
  }
  for (size_t at = 0; at < request->word_count; at++) {
    const narsil_partial_word *word = request->words + at;
    if (!expansion_text_region(&regions, word->written, word->written_length) ||
        !expansion_text_region(&regions, word->own, word->own_length)) {
      return 0;
    }
  }
  return 1;
}
