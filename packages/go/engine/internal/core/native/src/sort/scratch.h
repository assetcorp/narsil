#ifndef NARSIL_SORT_SCRATCH_H
#define NARSIL_SORT_SCRATCH_H

#include "../../include/narsil_core.h"

#include <stddef.h>
#include <stdint.h>

typedef struct {
  double *allocation;
  uint32_t capacity;
  size_t bytes;
} sort_scratch;

typedef struct {
  uint32_t *allocation;
  uint32_t capacity;
  size_t bytes;
} sort_order_scratch;

narsil_status reserve_sort_order(sort_order_scratch *scratch, uint32_t count);
sort_order_scratch *sort_order_workspace(narsil_workspace *workspace);

#endif
