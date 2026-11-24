#include "internal.h"

#include "../../include/narsil_analysis.h"
#include "../../include/narsil_core.h"
#include "../../include/narsil_expansion.h"
#include "../../include/narsil_folding.h"
#include "../analysis/text.h"
#include "../terms/dictionary.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

typedef struct {
  uint32_t segments[PARTIAL_BUDGET];
  uint32_t tokens[PARTIAL_BUDGET];
  double factors[PARTIAL_BUDGET];
  size_t count;
} partial_additions;

typedef struct {
  narsil_partial_word probe;
  size_t written;
  size_t probed;
} partial_probe;

static int probe_of(const narsil_partial_request *request, const narsil_term *folded, size_t word_index,
                    partial_probe *probe) {
  const narsil_partial_word *word = request->words + word_index;
  probe->probe = *word;
  if (folded != NULL) {
    probe->probe.written = folded[word_index].units;
    probe->probe.written_length = folded[word_index].length;
  }
  size_t own = 0;
  return expansion_point_count((term_cursor){word->written, NULL, 0, word->written_length}, &probe->written) &&
         expansion_point_count((term_cursor){word->own, NULL, 0, word->own_length}, &own) &&
         expansion_point_count((term_cursor){probe->probe.written, NULL, 0, probe->probe.written_length},
                               &probe->probed);
}

static narsil_status eligible_words(const narsil_partial_request *request, const narsil_term *folded,
                                    size_t *eligible) {
  *eligible = 0;
  for (size_t word_index = 0; word_index < request->word_count; word_index++) {
    partial_probe probe;
    if (!probe_of(request, folded, word_index, &probe)) { return NARSIL_INVALID_ARGUMENT; }
    if (probe.written >= PARTIAL_RUN_POINTS && *eligible < PARTIAL_BUDGET) { (*eligible)++; }
  }
  return NARSIL_OK;
}

static narsil_status add_word(narsil_workspace *workspace, expansion_scratch *scratch,
                              const narsil_partial_request *request, const narsil_fold_table *const *tables,
                              const partial_probe *probe, size_t share, partial_additions *additions) {
  scratch->count = 0;
  if (probe->probed > 0) {
    narsil_status status = partial_collect(workspace, scratch, request, tables, &probe->probe);
    if (status != NARSIL_OK) { return status; }
  }
  size_t take = share < scratch->count ? share : scratch->count;
  for (size_t next = 0; next < take; next++) {
    const expansion_candidate *candidate = scratch->candidates + next;
    additions->segments[additions->count] = candidate->segment;
    additions->tokens[additions->count] = candidate->token;
    additions->factors[additions->count++] = (double)probe->probed / (double)candidate->spelling_length;
  }
  return NARSIL_OK;
}

static narsil_status write_additions(const expansion_scratch *scratch, const partial_additions *additions,
                                     size_t word_count, const narsil_partial_output *output, uint32_t *count) {
  size_t needed = additions->count;
  const narsil_expansion_output *added = &output->additions;
  if (needed > added->segment_capacity || needed > added->token_capacity || needed > added->factor_capacity) {
    return NARSIL_NEEDS_ROOM;
  }
  if (needed > 0) {
    memcpy(added->segments, additions->segments, needed * sizeof *additions->segments);
    memcpy(added->tokens, additions->tokens, needed * sizeof *additions->tokens);
    memcpy(added->factors, additions->factors, needed * sizeof *additions->factors);
  }
  memcpy(output->starts, scratch->starts.values, (word_count + 1) * sizeof *output->starts);
  *count = (uint32_t)needed;
  return NARSIL_OK;
}

narsil_status partial_expand(narsil_workspace *workspace, const narsil_partial_request *request,
                             const narsil_fold_table *const *tables, const narsil_term *folded,
                             const narsil_partial_output *output, uint32_t *count) {
  size_t eligible = 0;
  narsil_status status = eligible_words(request, folded, &eligible);
  if (status != NARSIL_OK) { return status; }
  if (output->start_capacity < request->word_count + 1) { return NARSIL_NEEDS_ROOM; }
  expansion_scratch *scratch = workspace_expansion_scratch(workspace);
  int reserved = narsil_code_points_reserve(&scratch->starts, request->word_count + 1);
  if (reserved != NARSIL_OK) { return (narsil_status)reserved; }
  partial_additions additions;
  additions.count = 0;
  size_t order = 0;
  scratch->starts.values[0] = 0;
  for (size_t word_index = 0; word_index < request->word_count; word_index++) {
    partial_probe probe;
    if (!probe_of(request, folded, word_index, &probe)) { return NARSIL_INVALID_ARGUMENT; }
    if (probe.written >= PARTIAL_RUN_POINTS && order < eligible) {
      size_t share = (PARTIAL_BUDGET / eligible) + (size_t)(order < PARTIAL_BUDGET % eligible);
      order++;
      status = add_word(workspace, scratch, request, tables, &probe, share, &additions);
      if (status != NARSIL_OK) { return status; }
    }
    scratch->starts.values[word_index + 1] = (uint32_t)additions.count;
  }
  return write_additions(scratch, &additions, request->word_count, output, count);
}

narsil_status narsil_expand_partial_words(narsil_workspace *workspace, const narsil_partial_request *request,
                                          const narsil_partial_output *output, uint32_t *count) {
  if (workspace == NULL || !partial_regions(request, output, count)) { return NARSIL_INVALID_ARGUMENT; }
  return partial_expand(workspace, request, NULL, NULL, output, count);
}
