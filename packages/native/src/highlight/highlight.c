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

static int term_regions(const segment_regions *regions, const narsil_highlight_term *terms, size_t count) {
  if (count > UINT32_MAX || (uintptr_t)terms % _Alignof(narsil_highlight_term) != 0 ||
      !segment_region_input(regions, terms, count, sizeof *terms)) {
    return 0;
  }
  for (size_t at = 0; at < count; at++) {
    if (!text_region(regions, terms[at].text)) { return 0; }
  }
  return 1;
}

static int text_list_regions(const segment_regions *regions, const narsil_highlight_text *texts, size_t count) {
  if (count > UINT32_MAX || (uintptr_t)texts % _Alignof(narsil_highlight_text) != 0 ||
      !segment_region_input(regions, texts, count, sizeof *texts)) {
    return 0;
  }
  for (size_t at = 0; at < count; at++) {
    if (!text_region(regions, texts[at])) { return 0; }
  }
  return 1;
}

static int folded_regions(const segment_regions *regions, const narsil_folded_highlight *folded) {
  if (folded == NULL) { return 1; }
  return (uintptr_t)folded % _Alignof(narsil_folded_highlight) == 0 &&
         segment_region_input(regions, folded, 1, sizeof *folded) &&
         term_regions(regions, folded->keys, folded->key_count) && text_region(regions, folded->prefix) &&
         text_list_regions(regions, folded->partial_words, folded->partial_count);
}

static int query_regions(const segment_regions *regions, const narsil_highlight_query *query) {
  return term_regions(regions, query->terms, query->term_count) &&
         text_list_regions(regions, query->synonyms, query->synonym_count) &&
         text_list_regions(regions, query->partial_words, query->partial_count) &&
         text_region(regions, query->prefix) && folded_regions(regions, query->folded);
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
