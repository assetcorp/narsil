#ifndef NARSIL_FUSION_H
#define NARSIL_FUSION_H

#include "narsil_core.h"

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum { NARSIL_FUSION_RRF = 0, NARSIL_FUSION_LINEAR = 1 } narsil_fusion_strategy;

typedef struct {
  const uint32_t *keys;
  const double *scores;
  uint32_t count;
} narsil_fusion_leg;

typedef struct {
  uint32_t strategy;
  double rank_constant;
  double alpha;
  narsil_fusion_leg text;
  narsil_fusion_leg vector;
  const uint32_t *id_ranks;
  uint32_t key_count;
} narsil_fusion_request;

typedef struct {
  uint32_t *keys;
  double *scores;
  uint32_t capacity;
  uint32_t count;
} narsil_fusion_output;

narsil_status narsil_fuse(narsil_workspace *workspace, const narsil_fusion_request *request,
                          narsil_fusion_output *output);

#ifdef __cplusplus
}
#endif

#endif
