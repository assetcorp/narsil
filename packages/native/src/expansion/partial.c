#include "internal.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_expansion.h"
#include "../analysis/text.h"
#include "../terms/dictionary.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

static narsil_status eligible_words(const narsil_partial_request *request, size_t *eligible) {
  *eligible = 0;
  for (size_t at = 0; at < request->word_count; at++) {
    const narsil_partial_word *word = request->words + at;
    size_t written = 0;
    size_t own = 0;
    if (!expansion_point_count((term_cursor){word->written, NULL, 0, word->written_length}, &written) ||
        !expansion_point_count((term_cursor){word->own, NULL, 0, word->own_length}, &own)) {
      return NARSIL_INVALID_ARGUMENT;
    }
    if (written >= PARTIAL_RUN_POINTS && *eligible < PARTIAL_BUDGET) { (*eligible)++; }
  }
  return NARSIL_OK;
}

narsil_status narsil_expand_partial_words(narsil_workspace *workspace, const narsil_partial_request *request,
                                          const narsil_partial_output *output, uint32_t *count) {
  if (workspace == NULL || !partial_regions(request, output, count)) { return NARSIL_INVALID_ARGUMENT; }
  size_t eligible = 0;
  narsil_status validation = eligible_words(request, &eligible);
  if (validation != NARSIL_OK) { return validation; }
  if (output->start_capacity < request->word_count + 1) { return NARSIL_NEEDS_ROOM; }
  expansion_scratch *scratch = workspace_expansion_scratch(workspace);
  int reserved = narsil_code_points_reserve(&scratch->starts, request->word_count + 1);
  if (reserved != NARSIL_OK) { return (narsil_status)reserved; }
  uint32_t segments[PARTIAL_BUDGET];
  uint32_t tokens[PARTIAL_BUDGET];
  double factors[PARTIAL_BUDGET];
  size_t needed = 0;
  size_t order = 0;
  scratch->starts.values[0] = 0;
  for (size_t at = 0; at < request->word_count; at++) {
    const narsil_partial_word *word = request->words + at;
    size_t written = 0;
    if (!expansion_point_count((term_cursor){word->written, NULL, 0, word->written_length}, &written)) {
      return NARSIL_INVALID_ARGUMENT;
    }
    if (written >= PARTIAL_RUN_POINTS && order < eligible) {
      size_t share = (PARTIAL_BUDGET / eligible) + (size_t)(order < PARTIAL_BUDGET % eligible);
      order++;
      narsil_status status = partial_collect(workspace, scratch, request, word);
      if (status != NARSIL_OK) { return status; }
      size_t take = share < scratch->count ? share : scratch->count;
      for (size_t next = 0; next < take; next++) {
        const expansion_candidate *candidate = scratch->candidates + next;
        segments[needed] = candidate->segment;
        tokens[needed] = candidate->token;
        factors[needed++] = (double)written / (double)candidate->spelling_length;
      }
    }
    scratch->starts.values[at + 1] = (uint32_t)needed;
  }
  const narsil_expansion_output *added = &output->additions;
  if (needed > added->segment_capacity || needed > added->token_capacity || needed > added->factor_capacity) {
    return NARSIL_NEEDS_ROOM;
  }
  if (needed > 0) {
    memcpy(added->segments, segments, needed * sizeof *segments);
    memcpy(added->tokens, tokens, needed * sizeof *tokens);
    memcpy(added->factors, factors, needed * sizeof *factors);
  }
  memcpy(output->starts, scratch->starts.values, (request->word_count + 1) * sizeof *output->starts);
  *count = (uint32_t)needed;
  return NARSIL_OK;
}
