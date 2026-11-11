#ifndef NARSIL_PINNED_H
#define NARSIL_PINNED_H

#include "narsil_core.h"

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
  uint32_t count;
  const int32_t *ranked;
  size_t ranked_count;
  const uint32_t *positions;
  size_t position_count;
  uint32_t has_depth;
  uint32_t depth;
} narsil_pinned_request;

typedef struct {
  int32_t *entries;
  size_t capacity;
  uint32_t count;
} narsil_pinned_output;

narsil_status narsil_place_pinned(narsil_workspace *workspace, const narsil_pinned_request *request,
                                  narsil_pinned_output *output);

#ifdef __cplusplus
}
#endif

#endif
