#include "../../include/narsil_segments.h"

#include "../../include/narsil_core.h"
#include "../terms/table.h"
#include "postings.h"
#include "regions.h"
#include "removal.h"
#include "runs.h"
#include "scratch.h"
#include "strings.h"
#include "tokens.h"

#include <math.h>
#include <stddef.h>
#include <stdint.h>

static int valid_totals(const narsil_growing_segment *segment, uint32_t ordinal) {
  if (*segment->total_documents == 0 || *segment->total_documents > segment->ordinal_capacity) { return 0; }
  for (size_t field = 0; field < segment->field_count; field++) {
    if (!isfinite(segment->total_field_lengths[field]) ||
        segment->total_field_lengths[field] < segment->field_lengths[(field * segment->ordinal_capacity) + ordinal]) {
      return 0;
    }
  }
  return 1;
}

static void remove_surfaces(const segment_strings *strings, narsil_surface_table *table,
                            narsil_growing_segment *segment) {
  for (size_t index = 0; index < strings->count; index++) {
    const segment_string *entry = strings->entries + index;
    uint32_t held = table->count[entry->ordinal];
    uint32_t removed = entry->count < held ? entry->count : held;
    table->count[entry->ordinal] -= removed;
    if (table == segment->surfaces && entry->token < segment->terms.header[TERM_COUNT]) {
      double *total = segment->columns.surface_occurrences + entry->token;
      *total = fmax(0, *total - removed);
    }
    if (table->count[entry->ordinal] == 0) { segment_string_remove(&table->strings, entry); }
  }
}

static void remove_statistics(const narsil_index_terms_request *request) {
  narsil_growing_segment *segment = request->segment;
  for (size_t field = 0; field < segment->field_count; field++) {
    uint32_t *length = segment->field_lengths + (field * segment->ordinal_capacity) + request->ordinal;
    segment->total_field_lengths[field] = fmax(0, segment->total_field_lengths[field] - *length);
    *length = 0;
  }
  segment->retired[request->ordinal / SEGMENT_WORD_BITS] |= UINT32_C(1) << (request->ordinal % SEGMENT_WORD_BITS);
  (*segment->total_documents)--;
}

narsil_status narsil_remove_document(narsil_workspace *workspace, const narsil_index_terms_request *request) {
  if (workspace == NULL) { return NARSIL_INVALID_ARGUMENT; }
  segment_scratch *scratch = workspace_segment_scratch(workspace);
  segment_regions regions = {0};
  size_t count = 0;
  narsil_status status = segment_request_regions(&regions, request, &count, &scratch->regions);
  if (status != NARSIL_OK) { return status; }
  narsil_growing_segment *segment = request->segment;
  if (segment_row_removed(segment, request->ordinal)) { return NARSIL_OK; }
  if (!valid_totals(segment, request->ordinal)) { return NARSIL_INVALID_ARGUMENT; }
  status = segment_tokens_for_removal(&scratch->tokens, request, count);
  if (status != NARSIL_OK) { return status; }
  status = segment_removal_prepare(&scratch->removal, request, &scratch->tokens.terms);
  if (status != NARSIL_OK) { return status; }
  if (segment->spellings != NULL) {
    segment_strings *spellings = &scratch->tokens.spellings;
    for (size_t index = 0; index < spellings->count; index++) {
      segment_string *entry = spellings->entries + index;
      entry->added = entry->count >= segment->spellings->entries.count[entry->ordinal];
    }
    status = segment_runs_collect(&scratch->runs, spellings);
    if (status != NARSIL_OK) { return status; }
    status = segment_runs_prepare_removal(&scratch->runs, &segment->spellings->runs);
    if (status != NARSIL_OK) { return status; }
  }
  segment_removal_publish(&scratch->removal, request, &scratch->tokens.terms);
  if (segment->surfaces != NULL) { remove_surfaces(&scratch->tokens.surfaces, segment->surfaces, segment); }
  if (segment->spellings != NULL) {
    segment_runs_remove(&scratch->runs, &segment->spellings->runs);
    remove_surfaces(&scratch->tokens.spellings, &segment->spellings->entries, segment);
  }
  remove_statistics(request);
  return NARSIL_OK;
}
