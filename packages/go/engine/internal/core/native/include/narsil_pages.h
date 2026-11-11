#ifndef NARSIL_PAGES_H
#define NARSIL_PAGES_H

#include "narsil_core.h"

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
  uint32_t count;
  uint32_t sorted;
  uint32_t has_scores;
  uint32_t has_anchor_score;
  const double *scores;
  size_t scores_length;
  const uint32_t *score_present;
  size_t score_present_length;
  const uint32_t *after_anchor;
  size_t after_anchor_length;
  double anchor_score;
} narsil_page_request;

narsil_status narsil_page_start(const narsil_page_request *request, uint32_t *start);

#ifdef __cplusplus
}
#endif

#endif
