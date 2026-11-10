#include "scratch.h"

#include "../../include/narsil_analysis.h"
#include "../../include/narsil_core.h"
#include "../../include/narsil_highlight.h"
#include "../regions.h"
#include "../segments/regions.h"

#include <stddef.h>
#include <stdint.h>

static int text_region(const segment_regions *regions, narsil_highlight_text text) {
  return text.length <= NARSIL_MAX_ANALYSED_UNITS && (uintptr_t)text.units % _Alignof(uint16_t) == 0 &&
         segment_region_input(regions, text.units, text.length, sizeof *text.units);
}

static int query_regions(const segment_regions *regions, const narsil_highlight_query *query) {
  if (query->term_count > UINT32_MAX || query->synonym_count > UINT32_MAX || query->partial_count > UINT32_MAX ||
      (uintptr_t)query->terms % _Alignof(narsil_highlight_term) != 0 ||
      (uintptr_t)query->synonyms % _Alignof(narsil_highlight_text) != 0 ||
      (uintptr_t)query->partial_words % _Alignof(narsil_highlight_text) != 0 ||
      !segment_region_input(regions, query->terms, query->term_count, sizeof *query->terms) ||
      !segment_region_input(regions, query->synonyms, query->synonym_count, sizeof *query->synonyms) ||
      !segment_region_input(regions, query->partial_words, query->partial_count, sizeof *query->partial_words) ||
      !text_region(regions, query->prefix)) {
    return 0;
  }
  for (size_t at = 0; at < query->term_count; at++) {
    if (!text_region(regions, query->terms[at].text)) { return 0; }
  }
  for (size_t at = 0; at < query->synonym_count; at++) {
    if (!text_region(regions, query->synonyms[at])) { return 0; }
  }
  for (size_t at = 0; at < query->partial_count; at++) {
    if (!text_region(regions, query->partial_words[at])) { return 0; }
  }
  return 1;
}

static int valid_regions(const narsil_highlight_request *request, const narsil_highlight_output *output,
                         uint32_t *count) {
  if (request == NULL || (uintptr_t)request % _Alignof(narsil_highlight_request) != 0 || output == NULL ||
      (uintptr_t)output % _Alignof(narsil_highlight_output) != 0 || request->language >= narsil_language_count()) {
    return 0;
  }
  segment_regions regions = {0};
  if (!segment_region_write(&regions, output->snippet, output->snippet_capacity, sizeof *output->snippet) ||
      !segment_region_write(&regions, output->positions, output->position_words, sizeof *output->positions) ||
      !segment_region_write(&regions, output->snippet_length, output->length_capacity,
                            sizeof *output->snippet_length) ||
      !segment_region_write(&regions, count, 1, sizeof *count) ||
      !segment_region_input(&regions, request, 1, sizeof *request) ||
      !segment_region_input(&regions, output, 1, sizeof *output) || !text_region(&regions, request->text) ||
      !text_region(&regions, request->pre_tag) || !text_region(&regions, request->post_tag)) {
    return 0;
  }
  for (size_t at = 0; at < regions.write_count; at++) {
    for (size_t before = 0; before < at; before++) {
      if (overlaps(regions.writes[at], regions.writes[before])) { return 0; }
    }
  }
  return query_regions(&regions, &request->query);
}

narsil_status narsil_highlight(narsil_analyser *analyser, narsil_workspace *workspace,
                               const narsil_highlight_request *request, const narsil_highlight_output *output,
                               uint32_t *count) {
  if (analyser == NULL || workspace == NULL || !valid_regions(request, output, count)) {
    return NARSIL_INVALID_ARGUMENT;
  }
  if (output->length_capacity == 0) { return NARSIL_NEEDS_ROOM; }
  highlight_scratch *scratch = workspace_highlight_scratch(workspace);
  narsil_status status = highlight_matches(analyser, scratch, request);
  return status == NARSIL_OK ? highlight_render(scratch, request, output, count) : status;
}
