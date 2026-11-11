#ifndef NARSIL_FACET_SCRATCH_H
#define NARSIL_FACET_SCRATCH_H

#include "../../include/narsil_core.h"

#include <stddef.h>
#include <stdint.h>

typedef struct {
  void *allocation;
  double *values;
  uint32_t *positions;
  uint32_t *spare;
  uint32_t *counts;
  uint32_t *seen;
  uint32_t capacity;
  uint32_t words;
  size_t bytes;
} facet_scratch;

facet_scratch *workspace_facet_scratch(narsil_workspace *workspace);
narsil_status reserve_facet_scratch(facet_scratch *scratch, uint32_t count, size_t words);

#endif
