#include "../../include/narsil_segments.h"

#include "../../include/narsil_core.h"
#include "postings.h"
#include "regions.h"
#include "scratch.h"
#include "tokens.h"
#include "vacuum.h"

#include <stddef.h>

static narsil_status compact(narsil_workspace *workspace, narsil_growing_segment *segment) {
  segment_regions regions = {0};
  if (workspace == NULL || !segment_write_regions(&regions, segment)) { return NARSIL_INVALID_ARGUMENT; }
  segment_scratch *scratch = workspace_segment_scratch(workspace);
  narsil_index_terms_request request = {segment, 0, NULL, 0};
  narsil_status status = segment_postings_compact(&scratch->postings, &request);
  if (status != NARSIL_OK) { return status; }
  status = segment_vacuum_prepare(&scratch->vacuum, segment);
  if (status != NARSIL_OK) { return status; }
  if (scratch->vacuum.active) {
    segment_vacuum_publish(&scratch->vacuum, segment);
    return NARSIL_OK;
  }
  status = segment_repack_prepare(&scratch->vacuum, segment);
  if (status != NARSIL_OK) { return status; }
  if (scratch->vacuum.repacking) {
    segment_repack_publish(&scratch->vacuum, segment);
    return NARSIL_OK;
  }
  segment_token_plan tokens = {0};
  segment_postings_publish(&scratch->postings, &tokens, &request);
  return NARSIL_OK;
}

narsil_status narsil_begin_batch(narsil_workspace *workspace, narsil_growing_segment *segment) {
  return compact(workspace, segment);
}

narsil_status narsil_end_batch(narsil_workspace *workspace, narsil_growing_segment *segment) {
  return compact(workspace, segment);
}
