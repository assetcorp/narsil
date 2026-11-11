#include "internal.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_segment_merge.h"
#include "../segments/regions.h"

#include <stddef.h>
#include <stdint.h>

narsil_status narsil_measure_merge(narsil_workspace *workspace, const narsil_keyword_merge_request *request,
                                   narsil_keyword_merge_sizes *sizes) {
  segment_regions regions = {0};
  if (workspace == NULL || sizes == NULL || (uintptr_t)sizes % _Alignof(narsil_keyword_merge_sizes) != 0 ||
      !segment_region_write(&regions, sizes, sizeof *sizes, 1) || !segment_merge_inputs(request, &regions)) {
    return NARSIL_INVALID_ARGUMENT;
  }
  segment_merge_scratch *scratch = workspace_segment_merge_scratch(workspace);
  narsil_status status = segment_merge_prepare(scratch, request);
  if (status == NARSIL_OK) { *sizes = scratch->sizes; }
  return status;
}

static int strings_fit(const narsil_merged_strings *output, uint32_t count, uint32_t bytes, size_t stride) {
  return count <= (SIZE_MAX - 1) / stride && output->count_capacity >= count && output->text_capacity >= bytes &&
         output->offset_capacity >= ((size_t)count * stride) + 1;
}

static int fits(const narsil_keyword_merge_request *request, const narsil_keyword_merge_sizes *sizes,
                const narsil_keyword_merge_output *output) {
  return (request->field_count == 0 || request->document_count <= SIZE_MAX / request->field_count) &&
         strings_fit(&output->terms, sizes->terms, sizes->term_bytes, 1) &&
         strings_fit(&output->surfaces, sizes->surfaces, sizes->surface_bytes, 2) &&
         strings_fit(&output->spellings, sizes->spellings, sizes->spelling_bytes, 2) &&
         output->posting_offset_capacity > sizes->terms && output->posting_capacity >= sizes->postings &&
         (sizes->has_positions == 0 ||
          (output->position_offset_capacity > sizes->postings && output->position_capacity >= sizes->positions)) &&
         output->field_length_capacity >= (size_t)request->field_count * request->document_count &&
         output->field_count >= request->field_count;
}

narsil_status narsil_write_merge(narsil_workspace *workspace, const narsil_keyword_merge_request *request,
                                 const narsil_keyword_merge_output *output) {
  segment_regions regions = {0};
  if (workspace == NULL || !segment_merge_outputs(request, output, &regions)) { return NARSIL_INVALID_ARGUMENT; }
  segment_merge_scratch *scratch = workspace_segment_merge_scratch(workspace);
  narsil_status status = segment_merge_prepare(scratch, request);
  if (status != NARSIL_OK) { return status; }
  if (!fits(request, &scratch->sizes, output)) { return NARSIL_NEEDS_ROOM; }
  segment_merge_publish(scratch, request, output);
  return NARSIL_OK;
}
