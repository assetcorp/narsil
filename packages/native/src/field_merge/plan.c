#include "internal.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_field_merge.h"
#include "../segment_merge/internal.h"
#include "../segments/regions.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

void field_merge_release(field_merge_scratch *scratch) {
  free(scratch->documents);
  free(scratch->rows);
  free(scratch->keys);
  free(scratch->suffixes);
  free(scratch->key_targets);
  *scratch = (field_merge_scratch){0};
}

size_t field_merge_bytes(const field_merge_scratch *scratch) {
  return (scratch->document_capacity * sizeof *scratch->documents) + (scratch->row_capacity * sizeof *scratch->rows) +
         (scratch->key_capacity * sizeof *scratch->keys) + (scratch->suffix_capacity * sizeof *scratch->suffixes) +
         (scratch->key_target_capacity * sizeof *scratch->key_targets);
}

static narsil_status mapping(field_merge_scratch *scratch, const narsil_field_merge_request *request) {
  narsil_status status = segment_merge_reserve((void **)&scratch->documents, request->document_count,
                                               &scratch->document_capacity, sizeof *scratch->documents);
  if (status != NARSIL_OK) { return status; }
  for (size_t at = 0; at < request->document_count; at++) { scratch->documents[at] = (field_merge_document){0}; }
  size_t kept = 0;
  for (size_t at = 0; at < request->source_count; at++) {
    const narsil_field_merge_source *source = request->sources + at;
    for (size_t ordinal = 0; ordinal < source->document_count; ordinal++) {
      uint32_t target = source->mapping[ordinal];
      if (target == UINT32_MAX) { continue; }
      if (target >= request->document_count || scratch->documents[target].source != NULL) {
        return NARSIL_INVALID_ARGUMENT;
      }
      scratch->documents[target] = (field_merge_document){.source = source, .ordinal = (uint32_t)ordinal};
      kept++;
    }
  }
  return kept == request->document_count ? NARSIL_OK : NARSIL_INVALID_ARGUMENT;
}

narsil_status field_merge_prepare(field_merge_scratch *scratch, const narsil_field_merge_request *request) {
  scratch->sizes = (narsil_field_merge_sizes){0};
  scratch->row_count = 0;
  scratch->key_count = 0;
  narsil_status status = mapping(scratch, request);
  if (status != NARSIL_OK) { return status; }
  switch (request->kind) {
    case NARSIL_MERGE_NUMERIC:
    case NARSIL_MERGE_GEO:
      return field_merge_rows(scratch, request);
    case NARSIL_MERGE_BOOLEAN: {
      uint32_t words = request->document_count == 0 ? 1 : ((request->document_count - 1) / FIELD_MERGE_WORD_BITS) + 1;
      scratch->sizes.lengths[0] = words;
      scratch->sizes.lengths[1] = words;
      return NARSIL_OK;
    }
    case NARSIL_MERGE_ENUM:
    case NARSIL_MERGE_PATTERN:
      return field_merge_dictionary(scratch, request);
    case NARSIL_MERGE_STORED:
      return field_merge_stored(scratch, request);
    default:
      return NARSIL_INVALID_ARGUMENT;
  }
}

narsil_status narsil_measure_field_merge(narsil_workspace *workspace, const narsil_field_merge_request *request,
                                         narsil_field_merge_sizes *sizes) {
  segment_regions outputs = {0};
  if (workspace == NULL || sizes == NULL || (uintptr_t)sizes % _Alignof(narsil_field_merge_sizes) != 0 ||
      !segment_region_write(&outputs, sizes, NARSIL_FIELD_MERGE_REGIONS, sizeof *sizes->lengths) ||
      !field_merge_inputs(request, &outputs)) {
    return NARSIL_INVALID_ARGUMENT;
  }
  field_merge_scratch *scratch = workspace_field_merge_scratch(workspace);
  narsil_status status = field_merge_prepare(scratch, request);
  if (status == NARSIL_OK) { *sizes = scratch->sizes; }
  return status;
}

narsil_status narsil_write_field_merge(narsil_workspace *workspace, const narsil_field_merge_request *request,
                                       const narsil_field_merge_output *output) {
  segment_regions outputs = {0};
  if (workspace == NULL || !field_merge_outputs(request, output, &outputs)) { return NARSIL_INVALID_ARGUMENT; }
  field_merge_scratch *scratch = workspace_field_merge_scratch(workspace);
  narsil_status status = field_merge_prepare(scratch, request);
  if (status != NARSIL_OK) { return status; }
  for (size_t at = 0; at < NARSIL_FIELD_MERGE_REGIONS; at++) {
    if (output->regions[at].capacity < scratch->sizes.lengths[at]) { return NARSIL_NEEDS_ROOM; }
  }
  field_merge_publish(scratch, request, output);
  return NARSIL_OK;
}
