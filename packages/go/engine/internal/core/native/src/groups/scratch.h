#ifndef NARSIL_GROUP_SCRATCH_H
#define NARSIL_GROUP_SCRATCH_H

#include "../../include/narsil_groups.h"

typedef struct {
  uint32_t first;
  uint32_t end;
} hit_group;

typedef struct {
  void *allocation;
  size_t bytes;
  uint32_t capacity;
  hit_group *groups;
  uint32_t *positions;
  uint32_t *spare;
  uint32_t *order;
} group_scratch;

int group_request_valid(const narsil_group_request *request, const narsil_group_output *output);
uint32_t group_collect(const narsil_group_request *request, group_scratch *scratch);

#endif
