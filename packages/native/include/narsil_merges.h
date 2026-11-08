#ifndef NARSIL_MERGES_H
#define NARSIL_MERGES_H

#include "narsil_core.h"

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
  const uint32_t *offsets;
  size_t offset_count;
  const double *scores;
  size_t score_count;
  const uint32_t *ranks;
  size_t rank_count;
  uint32_t limit;
} narsil_merge_request;

typedef struct {
  uint32_t *lists;
  size_t list_capacity;
  uint32_t *indices;
  size_t index_capacity;
  uint32_t count;
} narsil_merge_output;

narsil_status narsil_merge_rankings(narsil_workspace *workspace, const narsil_merge_request *request,
                                    narsil_merge_output *output);
narsil_status narsil_merge_sorted(narsil_workspace *workspace, const narsil_merge_request *request,
                                  narsil_merge_output *output);

#ifdef __cplusplus
}
#endif

#endif
