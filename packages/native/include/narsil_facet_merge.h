#ifndef NARSIL_FACET_MERGE_H
#define NARSIL_FACET_MERGE_H

#include "narsil_core.h"

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
  const uint32_t *offsets;
  size_t offset_count;
  const uint32_t *values;
  size_t value_count;
  const uint32_t *counts;
  size_t count_count;
  const uint32_t *bounds;
  size_t bound_count;
  const uint32_t *ranks;
  size_t rank_count;
  uint32_t ascending;
  uint32_t has_limit;
  uint32_t limit;
} narsil_facet_merge_request;

typedef struct {
  uint32_t *values;
  size_t value_capacity;
  uint32_t *counts;
  size_t count_capacity;
  uint32_t *bound;
  size_t bound_capacity;
  uint32_t count;
} narsil_facet_merge_output;

narsil_status narsil_merge_facets(narsil_workspace *workspace, const narsil_facet_merge_request *request,
                                  narsil_facet_merge_output *output);

#ifdef __cplusplus
}
#endif

#endif
