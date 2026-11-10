#ifndef NARSIL_GROUP_MERGE_H
#define NARSIL_GROUP_MERGE_H

#include "narsil_core.h"

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
  const uint32_t *keys;
  size_t key_count;
  const uint32_t *offsets;
  size_t offset_count;
  const double *scores;
  size_t score_count;
  const uint32_t *score_present;
  size_t score_present_count;
  const uint32_t *ranks;
  size_t rank_count;
  const uint32_t *id_ranks;
  size_t id_rank_count;
  uint32_t has_scores;
  uint32_t has_score_present;
  uint32_t sorted;
  uint32_t max_per_group;
  uint32_t has_limit;
  uint32_t limit;
} narsil_group_merge_request;

typedef struct {
  uint32_t *keys;
  size_t key_capacity;
  uint32_t *offsets;
  size_t offset_capacity;
  uint32_t *sources;
  size_t source_capacity;
  uint32_t *indices;
  size_t index_capacity;
  uint32_t count;
} narsil_group_merge_output;

narsil_status narsil_merge_groups(narsil_workspace *workspace, const narsil_group_merge_request *request,
                                  narsil_group_merge_output *output);

#ifdef __cplusplus
}
#endif

#endif
