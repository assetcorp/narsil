#include "../include/narsil_fusion.h"

#include "internal.h"
#include "keyword/scratch.h"
#include "regions.h"

#include "../include/narsil_core.h"

#include <float.h>
#include <math.h>
#include <stddef.h>
#include <stdint.h>

static int valid_leg(narsil_fusion_leg leg) { return leg.count == 0 || (leg.keys != NULL && leg.scores != NULL); }

static int valid_regions(const narsil_fusion_request *request, const narsil_fusion_output *output) {
  enum { TEXT_KEYS, TEXT_SCORES, VECTOR_KEYS, VECTOR_SCORES, ID_RANKS, REQUEST, OUTPUT, INPUT_COUNT };
  memory_region inputs[INPUT_COUNT];
  memory_region keys;
  memory_region scores;
  memory_region count;
  if (!region_of(request->text.keys, request->text.count, sizeof *request->text.keys, &inputs[TEXT_KEYS]) ||
      !region_of(request->text.scores, request->text.count, sizeof *request->text.scores, &inputs[TEXT_SCORES]) ||
      !region_of(request->vector.keys, request->vector.count, sizeof *request->vector.keys, &inputs[VECTOR_KEYS]) ||
      !region_of(request->vector.scores, request->vector.count, sizeof *request->vector.scores,
                 &inputs[VECTOR_SCORES]) ||
      !region_of(request->id_ranks, request->key_count, sizeof *request->id_ranks, &inputs[ID_RANKS]) ||
      !region_of(request, 1, sizeof *request, &inputs[REQUEST]) ||
      !region_of(output, 1, offsetof(narsil_fusion_output, count), &inputs[OUTPUT]) ||
      !region_of(output->keys, output->capacity, sizeof *output->keys, &keys) ||
      !region_of(output->scores, output->capacity, sizeof *output->scores, &scores) ||
      !region_of(&output->count, 1, sizeof output->count, &count) || overlaps(keys, scores) || overlaps(keys, count) ||
      overlaps(scores, count)) {
    return 0;
  }
  for (size_t index = 0; index < INPUT_COUNT; index++) {
    if (overlaps(inputs[index], keys) || overlaps(inputs[index], scores) || overlaps(inputs[index], count)) {
      return 0;
    }
  }
  return 1;
}

static int valid_request(const narsil_fusion_request *request, const narsil_fusion_output *output) {
  return request != NULL && output != NULL && request->strategy <= NARSIL_FUSION_LINEAR &&
         isfinite(request->rank_constant) && request->rank_constant >= 1 &&
         floor(request->rank_constant) == request->rank_constant && isfinite(request->alpha) && request->alpha >= 0 &&
         request->alpha <= 1 && valid_leg(request->text) && valid_leg(request->vector) &&
         (request->key_count == 0 || request->id_ranks != NULL) &&
         (output->capacity == 0 || (output->keys != NULL && output->scores != NULL)) && valid_regions(request, output);
}

static double saturated_score(double score) {
  if (score > DBL_MAX) { return DBL_MAX; }
  if (score < -DBL_MAX) { return -DBL_MAX; }
  return score;
}

static level_range score_range(narsil_fusion_leg leg, uint32_t key_count) {
  level_range range = {0, 0};
  int found = 0;
  for (uint32_t position = 0; position < leg.count; position++) {
    if (leg.keys[position] >= key_count) { continue; }
    double score = saturated_score(leg.scores[position]);
    if (isnan(score)) { continue; }
    if (!found) {
      range.lower = score;
      range.upper = score;
      found = 1;
    } else {
      if (score < range.lower) { range.lower = score; }
      if (score > range.upper) { range.upper = score; }
    }
  }
  return range;
}

static double normalised_score(double score, level_range range, double width) {
  if (isnan(score)) { return 0; }
  if (width == 0) { return 1; }
  score = saturated_score(score);
  if (isfinite(width)) { return (score - range.lower) / width; }
  double half_min = range.lower / 2;
  return ((score / 2) - half_min) / ((range.upper / 2) - half_min);
}

static narsil_status add_leg(keyword_scratch *scratch, const narsil_fusion_request *request, narsil_fusion_leg leg,
                             uint32_t leg_bit, double *scores) {
  level_range range =
      request->strategy == NARSIL_FUSION_LINEAR ? score_range(leg, request->key_count) : (level_range){0, 0};
  double width = range.upper - range.lower;
  for (uint32_t position = 0; position < leg.count; position++) {
    uint32_t key = leg.keys[position];
    if (key >= request->key_count) { continue; }
    if (scratch->stamps[key] != scratch->generation) {
      scratch->stamps[key] = scratch->generation;
      scratch->scores[key] = 0;
      scratch->selection[key] = 0;
      scratch->covered[key] = 0;
      scratch->touched[scratch->touched_count++] = key;
    }
    if ((scratch->covered[key] & leg_bit) != 0) { return NARSIL_INVALID_ARGUMENT; }
    scratch->covered[key] |= leg_bit;
    if (request->strategy == NARSIL_FUSION_RRF) {
      scores[key] += 1 / (request->rank_constant + (double)position + 1);
    } else {
      scores[key] = normalised_score(leg.scores[position], range, width);
    }
  }
  return NARSIL_OK;
}

static int orders_before(const keyword_scratch *scratch, const uint32_t *id_ranks, uint32_t left, uint32_t right) {
  double left_score = scratch->scores[left];
  double right_score = scratch->scores[right];
  return left_score > right_score || (left_score == right_score && id_ranks[left] <= id_ranks[right]);
}

static size_t ordered_end(const keyword_scratch *scratch, const uint32_t *id_ranks, const uint32_t *order, size_t begin,
                          size_t count) {
  size_t end = begin + 1;
  while (end < count && orders_before(scratch, id_ranks, order[end - 1], order[end])) { end++; }
  return end;
}

static void sort_scores(keyword_scratch *scratch, const uint32_t *id_ranks) {
  size_t count = scratch->touched_count;
  for (size_t position = 0; position < count; position++) { scratch->order[position] = scratch->touched[position]; }
  uint32_t *source = scratch->order;
  uint32_t *target = scratch->order_spare;
  while (count > 1) {
    size_t runs = 0;
    for (size_t base = 0; base < count;) {
      size_t middle = ordered_end(scratch, id_ranks, source, base, count);
      if (base == 0 && middle == count) {
        scratch->order = source;
        scratch->order_spare = target;
        return;
      }
      size_t end = middle < count ? ordered_end(scratch, id_ranks, source, middle, count) : count;
      size_t left = base;
      size_t right = middle;
      for (size_t position = base; position < end; position++) {
        if (left < middle && (right == end || orders_before(scratch, id_ranks, source[left], source[right]))) {
          target[position] = source[left++];
        } else {
          target[position] = source[right++];
        }
      }
      runs++;
      base = end;
    }
    uint32_t *swapped = source;
    source = target;
    target = swapped;
    if (runs == 1) { break; }
  }
  scratch->order = source;
  scratch->order_spare = target;
}

narsil_status narsil_fuse(narsil_workspace *workspace, const narsil_fusion_request *request,
                          narsil_fusion_output *output) {
  if (workspace == NULL || !valid_request(request, output)) { return NARSIL_INVALID_ARGUMENT; }
  keyword_scratch *scratch = workspace_keyword_scratch(workspace);
  keyword_needs needs = {request->key_count, 1, 0, request->key_count, request->key_count, 0};
  narsil_status status = keyword_reserve(scratch, &needs);
  if (status != NARSIL_OK) { return status; }
  keyword_begin(scratch);
  status = add_leg(scratch, request, request->text, 1, scratch->scores);
  if (status != NARSIL_OK) { return status; }
  double *vector_scores = request->strategy == NARSIL_FUSION_RRF ? scratch->scores : scratch->selection;
  status = add_leg(scratch, request, request->vector, 2, vector_scores);
  if (status != NARSIL_OK) { return status; }
  if (scratch->touched_count > output->capacity) { return NARSIL_NEEDS_ROOM; }
  if (request->strategy == NARSIL_FUSION_LINEAR) {
    for (uint32_t position = 0; position < scratch->touched_count; position++) {
      uint32_t key = scratch->touched[position];
      double text = scratch->scores[key];
      double vector = scratch->selection[key];
      scratch->scores[key] = (request->alpha * vector) + ((1 - request->alpha) * text);
    }
  }
  sort_scores(scratch, request->id_ranks);
  for (uint32_t position = 0; position < scratch->touched_count; position++) {
    uint32_t key = scratch->order[position];
    output->keys[position] = key;
    output->scores[position] = scratch->scores[key];
  }
  output->count = scratch->touched_count;
  return NARSIL_OK;
}
