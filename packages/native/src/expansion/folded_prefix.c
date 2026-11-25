#include "folded.h"
#include "internal.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_expansion.h"
#include "../../include/narsil_folding.h"
#include "../analysis/text.h"
#include "../folding/table.h"
#include "../terms/dictionary.h"

#include <stddef.h>
#include <stdint.h>

static narsil_status add_fold_completions(expansion_scratch *scratch, const narsil_fold_table *table,
                                          const narsil_expansion_segment *source, uint32_t segment, fold_text folded) {
  for (size_t at = fold_lower_fold(table, folded); at < table->count; at++) {
    const fold_entry *entry = table->entries + table->by_fold[at];
    if (!fold_starts_with(fold_entry_fold(table, entry), folded)) { break; }
    if (entry->kind == FOLD_SPELLING || !fold_entry_held(table, entry, source)) { continue; }
    narsil_status status = expansion_add(scratch, source, segment, entry->token, 0);
    if (status != NARSIL_OK) { return status; }
  }
  return NARSIL_OK;
}

narsil_status narsil_expand_folded_prefix(narsil_workspace *workspace, const narsil_folded_prefix_request *request,
                                          const narsil_expansion_output *output, uint32_t *count) {
  if (workspace == NULL || !folded_prefix_regions(request, output, count)) { return NARSIL_INVALID_ARGUMENT; }
  const narsil_prefix_request *base = &request->prefix;
  size_t own = 0;
  size_t typed = 0;
  size_t points = 0;
  if (!expansion_prefix_points(base, &own, &typed) ||
      !expansion_point_count((term_cursor){request->folded, NULL, 0, request->folded_length}, &points)) {
    return NARSIL_INVALID_ARGUMENT;
  }
  if (typed == 0) {
    *count = 0;
    return NARSIL_OK;
  }
  expansion_scratch *scratch = workspace_expansion_scratch(workspace);
  narsil_status status = expansion_collect(workspace, scratch, base);
  if (status == NARSIL_OK && points > 0 &&
      !narsil_units_equal(request->folded, request->folded_length, base->typed, base->typed_length)) {
    narsil_prefix_request folded = *base;
    folded.typed = request->folded;
    folded.typed_length = request->folded_length;
    status = expansion_collect_more(workspace, scratch, &folded);
  }
  fold_text prefix = {request->folded, request->folded_length};
  for (size_t at = 0; status == NARSIL_OK && points > 0 && at < base->segment_count; at++) {
    status = add_fold_completions(scratch, request->tables[at], base->segments + at, (uint32_t)at, prefix);
  }
  if (status == NARSIL_OK) { status = expansion_rank(workspace, scratch, base); }
  if (status != NARSIL_OK) { return status; }
  return expansion_answer(scratch, own, output, count);
}

narsil_status narsil_expand_folded_partial_words(narsil_workspace *workspace,
                                                 const narsil_folded_partial_request *request,
                                                 const narsil_partial_output *output, uint32_t *count) {
  if (workspace == NULL || !folded_partial_regions(request, output, count)) { return NARSIL_INVALID_ARGUMENT; }
  return partial_expand(workspace, &request->partial, request->tables, request->folded, output, count);
}
