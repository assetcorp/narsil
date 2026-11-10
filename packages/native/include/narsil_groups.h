#ifndef NARSIL_GROUPS_H
#define NARSIL_GROUPS_H

#include "narsil_core.h"
#include "narsil_stored_values.h"

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
  const narsil_stored_values *values;
  size_t value_count;
  const uint32_t *ordinals;
  size_t ordinal_count;
  const double *scores;
  size_t score_count;
  const uint32_t *id_ranks;
  size_t id_rank_count;
  uint32_t max_per_group;
  uint32_t has_limit;
  uint32_t limit;
} narsil_group_request;

typedef struct {
  uint32_t *heads;
  size_t head_capacity;
  uint32_t *offsets;
  size_t offset_capacity;
  uint32_t *hits;
  size_t hit_capacity;
  uint32_t *members;
  size_t member_capacity;
  uint32_t count;
} narsil_group_output;

narsil_status narsil_group_hits(narsil_workspace *workspace, const narsil_group_request *request,
                                narsil_group_output *output);

#ifdef __cplusplus
}
#endif

#endif
