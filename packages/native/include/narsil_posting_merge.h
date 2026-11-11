#ifndef NARSIL_POSTING_MERGE_H
#define NARSIL_POSTING_MERGE_H

#include "narsil_segment_merge.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
  uint32_t *documents;
  uint16_t *frequencies;
  uint16_t *fields;
  size_t row_capacity;
  uint32_t *position_offsets;
  size_t offset_capacity;
  uint32_t *positions;
  size_t position_capacity;
  double *totals;
  size_t total_capacity;
} narsil_posting_merge_output;

narsil_status narsil_merge_postings(narsil_workspace *workspace, const narsil_keyword_merge_request *request,
                                    const narsil_posting_merge_output *output, uint32_t *count);

#ifdef __cplusplus
}
#endif

#endif
