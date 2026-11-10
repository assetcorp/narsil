#include "internal.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_frozen_segments.h"
#include "../../include/narsil_segment_merge.h"

#include <stddef.h>
#include <stdint.h>

narsil_status segment_merge_retained(segment_merge_scratch *scratch, const narsil_keyword_merge_request *request) {
  const narsil_frozen_strings *terms = request->retained_terms;
  if (terms->offsets[0] != 0 || terms->offsets[terms->count] != terms->text_bytes) { return NARSIL_INVALID_ARGUMENT; }
  for (size_t at = 0; at < request->input_count; at++) {
    if (request->inputs[at].growing != NULL || request->inputs[at].posting_count != 0 ||
        request->inputs[at].position_count != 0 || request->inputs[at].terms.count != 0) {
      return NARSIL_INVALID_ARGUMENT;
    }
  }
  void *allocation = scratch->terms;
  narsil_status status =
      segment_merge_reserve(&allocation, terms->count, &scratch->term_capacity, sizeof *scratch->terms);
  scratch->terms = allocation;
  if (status != NARSIL_OK) { return status; }
  scratch->term_count = terms->count;
  scratch->sizes.terms = (uint32_t)terms->count;
  scratch->sizes.term_bytes = (uint32_t)terms->text_bytes;
  for (size_t at = 0; at < terms->count; at++) {
    merge_text text;
    if (!segment_merge_text(terms, at, &text) || terms->counts[at] == 0 ||
        terms->counts[at] > request->document_count ||
        (at > 0 && segment_merge_compare_text(scratch->terms[at - 1].text, text) >= 0)) {
      return NARSIL_INVALID_ARGUMENT;
    }
    scratch->terms[at] = (merge_term){.text = text, .ordinal = (uint32_t)at, .target = (uint32_t)at};
  }
  return NARSIL_OK;
}
