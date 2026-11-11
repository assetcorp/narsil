#include "internal.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_expansion.h"
#include "../../include/narsil_terms.h"
#include "../analysis/text.h"
#include "../terms/dictionary.h"
#include "../terms/matching.h"

#include <stddef.h>
#include <stdint.h>

static narsil_status prepare_word(expansion_scratch *scratch, const narsil_partial_word *word) {
  int status = term_points((term_cursor){word->written, NULL, 0, word->written_length}, &scratch->written);
  if (status != 1) { return status == 0 ? NARSIL_INVALID_ARGUMENT : (narsil_status)-status; }
  status = term_points((term_cursor){word->own, NULL, 0, word->own_length}, &scratch->typo.query);
  if (status != 1) { return status == 0 ? NARSIL_INVALID_ARGUMENT : (narsil_status)-status; }
  status = narsil_code_points_reserve(&scratch->failure, scratch->written.length);
  if (status != NARSIL_OK) { return (narsil_status)status; }
  scratch->failure.values[0] = 0;
  uint32_t matched = 0;
  for (size_t at = 1; at < scratch->written.length; at++) {
    uint32_t point = scratch->written.values[at];
    while (matched > 0 && point != scratch->written.values[matched]) { matched = scratch->failure.values[matched - 1]; }
    if (point == scratch->written.values[matched]) { matched++; }
    scratch->failure.values[at] = matched;
  }
  return NARSIL_OK;
}

static int contains(const expansion_scratch *scratch, term_cursor text) {
  size_t matched = 0;
  uint32_t point = 0;
  while (term_next(&text, &point) > 0) {
    while (matched > 0 && point != scratch->written.values[matched]) { matched = scratch->failure.values[matched - 1]; }
    if (point == scratch->written.values[matched]) { matched++; }
    if (matched == scratch->written.length) { return 1; }
  }
  return 0;
}

static narsil_status collect_source(expansion_scratch *scratch, const narsil_expansion_segment *source,
                                    const narsil_frozen_runs *runs, const narsil_partial_word *word, uint32_t segment) {
  const uint32_t *members = NULL;
  size_t count = 0;
  if (!partial_members(source, runs, &scratch->written, &members, &count)) { return NARSIL_OK; }
  narsil_term_dictionary dictionary;
  if (!expansion_dictionary(source, &dictionary)) { return NARSIL_INVALID_ARGUMENT; }
  narsil_term_lookup exclusion = {.dictionary = &dictionary,
                                  .operation = NARSIL_LOOKUP_TYPO,
                                  .tolerance = word->tolerance,
                                  .prefix_length = word->prefix_length};
  for (size_t at = 0; at < count; at++) {
    term_cursor spelling;
    uint32_t token = 0;
    size_t length = 0;
    if (!partial_spelling(source, members[at], &spelling, &token, &length) || length <= scratch->written.length ||
        !contains(scratch, spelling)) {
      continue;
    }
    int excluded = term_matches(&exclusion, &scratch->typo, token);
    if (excluded < 0) { return (narsil_status)-excluded; }
    if (excluded) { continue; }
    narsil_status status = expansion_add(scratch, source, segment, token, length);
    if (status != NARSIL_OK) { return status; }
  }
  return NARSIL_OK;
}

narsil_status partial_collect(narsil_workspace *workspace, expansion_scratch *scratch,
                              const narsil_partial_request *request, const narsil_partial_word *word) {
  scratch->count = 0;
  narsil_status status = prepare_word(scratch, word);
  for (size_t at = 0; status == NARSIL_OK && at < request->segment_count; at++) {
    status = collect_source(scratch, request->segments + at, request->runs + at, word, (uint32_t)at);
  }
  narsil_prefix_request ranked = {.segments = request->segments, .segment_count = request->segment_count};
  return status == NARSIL_OK ? expansion_rank(workspace, scratch, &ranked) : status;
}
