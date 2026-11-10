#include "../include/narsil_pages.h"

#include "regions.h"
#include "score_order.h"

#include "../include/narsil_core.h"

#include <stddef.h>
#include <stdint.h>

enum { BITSET_WORD_BITS = 32, BITSET_WORD_SHIFT = 5, BITSET_WORD_MASK = 31 };

static int valid_regions(const narsil_page_request *request, const uint32_t *start) {
  memory_region scores;
  memory_region present;
  memory_region after;
  memory_region output;
  memory_region metadata;
  return region_of(request->scores, request->scores_length, sizeof *request->scores, &scores) &&
         region_of(request->score_present, request->score_present_length, sizeof *request->score_present, &present) &&
         region_of(request->after_anchor, request->after_anchor_length, sizeof *request->after_anchor, &after) &&
         region_of(start, 1, sizeof *start, &output) && !overlaps(output, scores) && !overlaps(output, present) &&
         !overlaps(output, after) && region_of(request, 1, sizeof *request, &metadata) && !overlaps(output, metadata);
}

static int valid_request(const narsil_page_request *request) {
  if (request == NULL || request->sorted > 1 || request->has_scores > 1 || request->has_anchor_score > 1) { return 0; }
  size_t words = request->count == 0 ? 1 : ((size_t)(request->count - 1) / BITSET_WORD_BITS) + 1;
  if (request->after_anchor == NULL || request->after_anchor_length < words) { return 0; }
  if (request->has_scores == 0) {
    return request->scores == NULL && request->scores_length == 0 && request->score_present == NULL &&
           request->score_present_length == 0;
  }
  if (request->scores_length != request->count || (request->count != 0 && request->scores == NULL)) { return 0; }
  return request->score_present == NULL ? request->score_present_length == 0 : request->score_present_length >= words;
}

narsil_status narsil_page_start(const narsil_page_request *request, uint32_t *start) {
  if (start == NULL || !valid_request(request) || !valid_regions(request, start)) { return NARSIL_INVALID_ARGUMENT; }
  for (uint32_t position = 0; position < request->count; position++) {
    uint32_t mask = UINT32_C(1) << (position & BITSET_WORD_MASK);
    size_t word = position >> BITSET_WORD_SHIFT;
    int after = (request->after_anchor[word] & mask) != 0;
    if (request->sorted == 0) {
      if (request->has_anchor_score == 0 || request->has_scores == 0 ||
          (request->score_present != NULL && (request->score_present[word] & mask) == 0)) {
        after = 1;
      } else {
        int order = score_order(request->scores[position], request->anchor_score);
        after = order > 0 || (order == 0 && after);
      }
    }
    if (after) {
      *start = position;
      return NARSIL_OK;
    }
  }
  *start = request->count;
  return NARSIL_OK;
}
