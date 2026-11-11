#include "internal.h"

#include "../../include/narsil_analysis.h"
#include "../../include/narsil_core.h"
#include "../../include/narsil_expansion.h"
#include "../../include/narsil_terms.h"
#include "../analysis/text.h"
#include "../terms/dictionary.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

int expansion_point_count(term_cursor cursor, size_t *count) {
  *count = 0;
  size_t units = 0;
  uint32_t point = 0;
  int next = 0;
  while ((next = term_next(&cursor, &point)) > 0) {
    if (point >= NARSIL_HIGH_SURROGATE_FIRST && point < NARSIL_SURROGATE_END) { return 0; }
    units += point > UINT16_MAX ? 2 : 1;
    if (units > NARSIL_MAX_ANALYSED_UNITS) { return 0; }
    (*count)++;
  }
  return next == 0;
}

static int order_text(const expansion_candidate *first, const expansion_candidate *second) {
  int order = expansion_compare(first->text, second->text);
  if (order != 0) { return order; }
  if (first->segment != second->segment) { return first->segment < second->segment ? -1 : 1; }
  return (first->token > second->token) - (first->token < second->token);
}

static int compare_text(const void *first, const void *second) { return order_text(first, second); }

static int order_rank(const expansion_candidate *first, const expansion_candidate *second) {
  if (first->documents != second->documents) { return first->documents > second->documents ? -1 : 1; }
  return order_text(first, second);
}

static int compare_rank(const void *first, const void *second) { return order_rank(first, second); }

narsil_status expansion_rank(narsil_workspace *workspace, expansion_scratch *scratch,
                             const narsil_prefix_request *request) {
  if (scratch->count > 1) { qsort(scratch->candidates, scratch->count, sizeof *scratch->candidates, compare_text); }
  size_t kept = 0;
  for (size_t at = 0; at < scratch->count;) {
    expansion_candidate candidate = scratch->candidates[at++];
    while (at < scratch->count && expansion_compare(candidate.text, scratch->candidates[at].text) == 0) {
      if (scratch->candidates[at].spelling_length < candidate.spelling_length) {
        candidate.spelling_length = scratch->candidates[at].spelling_length;
      }
      at++;
    }
    for (size_t source = 0; source < request->segment_count; source++) {
      uint32_t token = 0;
      uint32_t found = 0;
      const narsil_expansion_segment *segment = request->segments + source;
      narsil_status status = expansion_find(workspace, scratch, segment, candidate.text, &token, &found);
      if (status != NARSIL_OK) { return status; }
      if (found == 0) { continue; }
      narsil_term_dictionary dictionary;
      if (!expansion_dictionary(segment, &dictionary)) { return NARSIL_INVALID_ARGUMENT; }
      candidate.documents += dictionary_frequency(&dictionary, token);
    }
    if (candidate.documents > 0) { scratch->candidates[kept++] = candidate; }
  }
  scratch->count = kept;
  if (kept > 1) { qsort(scratch->candidates, kept, sizeof *scratch->candidates, compare_rank); }
  return NARSIL_OK;
}

narsil_status narsil_expand_prefix(narsil_workspace *workspace, const narsil_prefix_request *request,
                                   const narsil_expansion_output *output, uint32_t *count) {
  if (workspace == NULL || !expansion_regions(request, output, count)) { return NARSIL_INVALID_ARGUMENT; }
  size_t own = 0;
  size_t typed = 0;
  size_t stemmed = 0;
  if (!expansion_point_count((term_cursor){request->own, NULL, 0, request->own_length}, &own) ||
      !expansion_point_count((term_cursor){request->typed, NULL, 0, request->typed_length}, &typed) ||
      !expansion_point_count((term_cursor){request->stemmed, NULL, 0, request->stemmed_length}, &stemmed)) {
    return NARSIL_INVALID_ARGUMENT;
  }
  if (typed == 0) {
    *count = 0;
    return NARSIL_OK;
  }
  expansion_scratch *scratch = workspace_expansion_scratch(workspace);
  narsil_status status = expansion_collect(workspace, scratch, request);
  if (status == NARSIL_OK) { status = expansion_rank(workspace, scratch, request); }
  if (status != NARSIL_OK) { return status; }
  size_t needed = scratch->count < PREFIX_BUDGET ? scratch->count : PREFIX_BUDGET;
  if (needed > output->segment_capacity || needed > output->token_capacity || needed > output->factor_capacity) {
    return NARSIL_NEEDS_ROOM;
  }
  double factors[PREFIX_BUDGET];
  for (size_t at = 0; at < needed; at++) {
    size_t points = 0;
    if (!expansion_point_count(scratch->candidates[at].text, &points) || points == 0) {
      return NARSIL_INVALID_ARGUMENT;
    }
    double ratio = (double)own / (double)points;
    factors[at] = ratio < 1 ? ratio : 1;
  }
  for (size_t at = 0; at < needed; at++) {
    output->segments[at] = scratch->candidates[at].segment;
    output->tokens[at] = scratch->candidates[at].token;
    output->factors[at] = factors[at];
  }
  *count = (uint32_t)needed;
  return NARSIL_OK;
}
