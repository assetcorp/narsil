#include "../../include/narsil_segments.h"

#include "../../include/narsil_core.h"
#include "../terms/table.h"
#include "postings.h"
#include "regions.h"
#include "runs.h"
#include "scratch.h"
#include "strings.h"
#include "tokens.h"

#include <math.h>
#include <stddef.h>
#include <stdint.h>

static int valid_statistics(const narsil_growing_segment *segment) {
  if (*segment->total_documents >= segment->ordinal_capacity) { return 0; }
  for (size_t field = 0; field < segment->field_count; field++) {
    if (!isfinite(segment->total_field_lengths[field]) || segment->total_field_lengths[field] < 0) { return 0; }
  }
  return 1;
}

static void publish_surfaces(const segment_strings *strings, narsil_surface_table *table) {
  segment_strings_publish(strings, &table->strings);
  for (size_t index = 0; index < strings->count; index++) {
    const segment_string *entry = strings->entries + index;
    table->token[entry->ordinal] = entry->token;
    table->count[entry->ordinal] = (entry->added ? 0 : table->count[entry->ordinal]) + entry->count;
  }
}

static void publish_strings(const segment_token_plan *plan, narsil_growing_segment *segment) {
  if (segment->surfaces != NULL) {
    publish_surfaces(&plan->surfaces, segment->surfaces);
    for (size_t index = 0; index < plan->surfaces.count; index++) {
      const segment_string *entry = plan->surfaces.entries + index;
      if (entry->token < segment->terms.header[TERM_COUNT]) {
        segment->columns.surface_occurrences[entry->token] += entry->count;
      }
    }
  }
  if (segment->spellings != NULL) {
    publish_surfaces(&plan->spellings, &segment->spellings->entries);
    for (size_t index = 0; index < plan->spellings.count; index++) {
      const segment_string *entry = plan->spellings.entries + index;
      segment->spellings->code_points[entry->ordinal] = entry->points;
    }
  }
}

static void publish_statistics(const narsil_index_terms_request *request) {
  narsil_growing_segment *segment = request->segment;
  for (size_t field = 0; field < segment->field_count; field++) {
    segment->field_lengths[(field * segment->ordinal_capacity) + request->ordinal] = 0;
  }
  for (size_t index = 0; index < request->field_count; index++) {
    const narsil_field_tokens *field = request->fields + index;
    segment->field_lengths[((size_t)field->field * segment->ordinal_capacity) + request->ordinal] =
        field->tokens.token_count;
    segment->total_field_lengths[field->field] += field->tokens.token_count;
  }
  (*segment->total_documents)++;
}

narsil_status narsil_index_terms(narsil_workspace *workspace, const narsil_index_terms_request *request) {
  if (workspace == NULL) { return NARSIL_INVALID_ARGUMENT; }
  segment_regions regions = {0};
  size_t count = 0;
  narsil_status status = segment_request_regions(&regions, request, &count);
  if (status != NARSIL_OK) { return status; }
  if (!valid_statistics(request->segment)) { return NARSIL_INVALID_ARGUMENT; }
  segment_scratch *scratch = workspace_segment_scratch(workspace);
  status = segment_tokens_prepare(&scratch->tokens, request, count);
  if (status != NARSIL_OK) { return status; }
  status = segment_postings_prepare(&scratch->postings, &scratch->tokens, request);
  if (status != NARSIL_OK) { return status; }
  if (request->segment->spellings != NULL) {
    status = segment_runs_collect(&scratch->runs, &scratch->tokens.spellings);
    if (status != NARSIL_OK) { return status; }
    status = segment_runs_prepare(&scratch->runs, &request->segment->spellings->runs);
    if (status != NARSIL_OK) { return status; }
  }
  segment_strings_publish(&scratch->tokens.terms, &request->segment->terms);
  segment_postings_publish(&scratch->postings, &scratch->tokens, request);
  publish_strings(&scratch->tokens, request->segment);
  if (request->segment->spellings != NULL) { segment_runs_publish(&scratch->runs, &request->segment->spellings->runs); }
  publish_statistics(request);
  return NARSIL_OK;
}
