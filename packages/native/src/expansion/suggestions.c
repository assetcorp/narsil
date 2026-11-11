#include "suggestions.h"
#include "internal.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_expansion.h"
#include "../../include/narsil_suggestions.h"
#include "../regions.h"
#include "../segments/regions.h"
#include "../terms/dictionary.h"

#include <stddef.h>
#include <stdint.h>

static int regions_of(const narsil_suggestion_request *request, const narsil_suggestion_output *output,
                      uint32_t *count) {
  if (request == NULL || (uintptr_t)request % _Alignof(narsil_suggestion_request) != 0 || output == NULL ||
      (uintptr_t)output % _Alignof(narsil_suggestion_output) != 0 || request->segment_count > UINT32_MAX ||
      (uintptr_t)request->segments % _Alignof(narsil_expansion_segment) != 0) {
    return 0;
  }
  segment_regions regions = {0};
  if (!segment_region_write(&regions, output->terms, output->term_words, sizeof *output->terms) ||
      !segment_region_write(&regions, output->starts, output->start_capacity, sizeof *output->starts) ||
      !segment_region_write(&regions, output->spellings, output->spelling_words, sizeof *output->spellings) ||
      !segment_region_write(&regions, output->occurrences, output->occurrence_capacity, sizeof *output->occurrences) ||
      !segment_region_write(&regions, count, 1, sizeof *count) ||
      !segment_region_input(&regions, request, 1, sizeof *request) ||
      !segment_region_input(&regions, output, 1, sizeof *output) ||
      !segment_region_input(&regions, request->segments, request->segment_count, sizeof *request->segments) ||
      !expansion_text_region(&regions, request->typed, request->typed_length) ||
      !expansion_text_region(&regions, request->stemmed, request->stemmed_length)) {
    return 0;
  }
  for (size_t at = 0; at < regions.write_count; at++) {
    for (size_t before = 0; before < at; before++) {
      if (overlaps(regions.writes[at], regions.writes[before])) { return 0; }
    }
  }
  for (size_t at = 0; at < request->segment_count; at++) {
    if (!expansion_source_regions(request->segments + at, &regions)) { return 0; }
  }
  size_t points = 0;
  return expansion_point_count((term_cursor){request->typed, NULL, 0, request->typed_length}, &points) &&
         expansion_point_count((term_cursor){request->stemmed, NULL, 0, request->stemmed_length}, &points);
}

static narsil_status publish(const suggestion_scratch *scratch, size_t groups, const narsil_suggestion_output *output,
                             uint32_t *count) {
  size_t spellings = 0;
  for (size_t at = 0; at < groups; at++) {
    size_t length = scratch->groups[at].end - scratch->groups[at].start;
    if (length > UINT32_MAX - spellings) { return NARSIL_INVALID_ARGUMENT; }
    spellings += length;
  }
  if (groups == SIZE_MAX || groups > output->term_words / NARSIL_SUGGESTION_WORDS ||
      groups + 1 > output->start_capacity || spellings > output->spelling_words / NARSIL_SUGGESTION_WORDS ||
      spellings > output->occurrence_capacity) {
    return NARSIL_NEEDS_ROOM;
  }
  size_t written = 0;
  output->starts[0] = 0;
  for (size_t at = 0; at < groups; at++) {
    const suggestion_group *group = scratch->groups + at;
    uint32_t *term = output->terms + (at * NARSIL_SUGGESTION_WORDS);
    term[0] = group->segment;
    term[1] = group->token;
    term[2] = group->documents;
    for (size_t next = group->start; next < group->end; next++) {
      const suggestion_entry *entry = scratch->entries + next;
      uint32_t *spelling = output->spellings + (written * NARSIL_SUGGESTION_WORDS);
      spelling[0] = entry->segment;
      spelling[1] = entry->kind;
      spelling[2] = entry->entry;
      output->occurrences[written++] = entry->occurrences;
    }
    output->starts[at + 1] = (uint32_t)written;
  }
  *count = (uint32_t)groups;
  return NARSIL_OK;
}

narsil_status narsil_suggest_terms(narsil_workspace *workspace, const narsil_suggestion_request *request,
                                   const narsil_suggestion_output *output, uint32_t *count) {
  if (workspace == NULL || !regions_of(request, output, count)) { return NARSIL_INVALID_ARGUMENT; }
  expansion_scratch *scratch = workspace_expansion_scratch(workspace);
  size_t groups = 0;
  if (request->typed_length > 0 && request->limit > 0) {
    narsil_status status = suggestion_collect(workspace, scratch, request);
    if (status != NARSIL_OK) { return status; }
    groups = scratch->suggestions.group_count;
    if (groups > request->limit) { groups = request->limit; }
  }
  return publish(&scratch->suggestions, groups, output, count);
}
