#include "internal.h"

#include "../../include/narsil_analysis.h"
#include "../../include/narsil_expansion.h"
#include "../regions.h"
#include "../segments/frozen.h"
#include "../segments/regions.h"

#include <math.h>
#include <stddef.h>
#include <stdint.h>

static int growing_regions(const narsil_expansion_segment *source, const segment_regions *outputs) {
  segment_regions held = {0};
  if (!segment_write_regions(&held, source->growing)) { return 0; }
  for (size_t at = 0; at < held.write_count; at++) {
    for (size_t output = 0; output < outputs->write_count; output++) {
      if (overlaps(held.writes[at], outputs->writes[output])) { return 0; }
    }
  }
  for (size_t at = 0; at < held.read_count; at++) {
    for (size_t output = 0; output < outputs->write_count; output++) {
      if (overlaps(held.reads[at], outputs->writes[output])) { return 0; }
    }
  }
  return 1;
}

int expansion_text_region(const segment_regions *outputs, const uint16_t *text, size_t length) {
  return length <= NARSIL_MAX_ANALYSED_UNITS && (uintptr_t)text % _Alignof(uint16_t) == 0 &&
         segment_region_input(outputs, text, length, sizeof *text);
}

int expansion_source_regions(const narsil_expansion_segment *source, const segment_regions *outputs) {
  if (source->growing != NULL) {
    return source->frozen == NULL && source->state == NULL && source->occurrences == NULL &&
           source->occurrence_count == 0 && growing_regions(source, outputs);
  }
  if (!frozen_read_regions(source->frozen, source->state, outputs)) { return 0; }
  if (source->occurrences == NULL) { return source->occurrence_count == 0; }
  if (source->occurrence_count != source->frozen->terms.count ||
      (uintptr_t)source->occurrences % _Alignof(double) != 0 ||
      !segment_region_input(outputs, source->occurrences, source->occurrence_count, sizeof *source->occurrences)) {
    return 0;
  }
  for (size_t at = 0; at < source->occurrence_count; at++) {
    if (!isfinite(source->occurrences[at]) || source->occurrences[at] < 0) { return 0; }
  }
  return 1;
}

int expansion_regions(const narsil_prefix_request *request, const narsil_expansion_output *output, uint32_t *count) {
  if (request == NULL || (uintptr_t)request % _Alignof(narsil_prefix_request) != 0 || output == NULL ||
      (uintptr_t)output % _Alignof(narsil_expansion_output) != 0 || request->segment_count > UINT32_MAX ||
      (uintptr_t)request->segments % _Alignof(narsil_expansion_segment) != 0) {
    return 0;
  }
  segment_regions regions = {0};
  if (!segment_region_write(&regions, output->segments, output->segment_capacity, sizeof *output->segments) ||
      !segment_region_write(&regions, output->tokens, output->token_capacity, sizeof *output->tokens) ||
      !segment_region_write(&regions, output->factors, output->factor_capacity, sizeof *output->factors) ||
      !segment_region_write(&regions, count, 1, sizeof *count) ||
      !segment_region_input(&regions, request, 1, sizeof *request) ||
      !segment_region_input(&regions, output, 1, sizeof *output) ||
      !segment_region_input(&regions, request->segments, request->segment_count, sizeof *request->segments) ||
      !expansion_text_region(&regions, request->typed, request->typed_length) ||
      !expansion_text_region(&regions, request->stemmed, request->stemmed_length) ||
      !expansion_text_region(&regions, request->own, request->own_length)) {
    return 0;
  }
  for (size_t at = 0; at < regions.write_count; at++) {
    for (size_t before = 0; before < at; before++) {
      if (overlaps(regions.writes[at], regions.writes[before])) { return 0; }
    }
  }
  for (size_t at = 0; at < request->segment_count; at++) {
    const narsil_expansion_segment *source = request->segments + at;
    if (!expansion_source_regions(source, &regions)) { return 0; }
  }
  return 1;
}
