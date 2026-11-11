#ifndef NARSIL_GROUP_MERGE_SCRATCH_H
#define NARSIL_GROUP_MERGE_SCRATCH_H

#include "../../include/narsil_group_merge.h"

enum { GROUP_SCORE_WORD_BITS = 32 };

typedef struct {
  uint32_t index;
  uint32_t source;
} group_entry_position;

typedef struct {
  double score;
  uint32_t key;
  uint32_t first;
  uint32_t end;
  uint32_t source;
  uint32_t retained;
  uint32_t id_rank;
} merged_group;

typedef struct {
  void *allocation;
  size_t bytes;
  uint32_t capacity;
  merged_group *groups;
  uint32_t *sources;
  uint32_t *spare;
  uint32_t *order;
  uint32_t *heap;
  uint32_t *positions;
} group_merge_scratch;

narsil_status group_merge_reserve(group_merge_scratch *scratch, uint32_t groups);
int group_merge_valid(const narsil_group_merge_request *request, const narsil_group_merge_output *output);
double group_entry_score(double absent, const narsil_group_merge_request *request, uint32_t entry);
int group_entry_before(const narsil_group_merge_request *request, group_entry_position left,
                       group_entry_position right);
uint32_t group_merge_collect(const narsil_group_merge_request *request, group_merge_scratch *scratch);
void group_merge_write(const narsil_group_merge_request *request, group_merge_scratch *scratch, uint32_t retained,
                       narsil_group_merge_output *output);

#endif
