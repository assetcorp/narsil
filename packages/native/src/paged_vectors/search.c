#include "internal.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_paged.h"
#include "../../include/narsil_paged_vectors.h"
#include "../internal.h"
#include "../score_order.h"
#include "../segments/regions.h"
#include "../work/tally.h"
#include "scratch.h"

#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

static narsil_status prepare(paged_walk *walk) {
  uint32_t dimension = walk->field->dimension;
  narsil_status status = workspace_reserve_dimension(walk->workspace, dimension);
  if (status != NARSIL_OK) { return status; }
  status = workspace_reserve_visited(walk->workspace, walk->field->total);
  if (status != NARSIL_OK) { return status; }
  uint32_t bits = walk->field->bits;
  size_t code_bytes = (size_t)((((uint64_t)dimension * bits) + (PAGED_BYTE_BITS - 1)) / PAGED_BYTE_BITS);
  size_t candidates = walk->request->ef < walk->field->total ? walk->request->ef : walk->field->total;
  status = paged_vector_reserve(candidates, walk->scratch, code_bytes + NARSIL_OSQ_TRAILER_BYTES);
  if (status != NARSIL_OK) { return status; }
  walk->magnitude = (double)kernel_magnitude(walk->request->query, dimension);
  if (bits != 0) {
    walk->code_store.dimension = dimension;
    walk->code_store.bits = bits;
    walk->code_store.centroid = walk->workspace->other_vector;
    memcpy(walk->code_store.centroid, walk->field->centroid, (size_t)dimension * sizeof(float));
    walk->codes.store = &walk->code_store;
    walk->codes.workspace = walk->workspace;
    walk->codes.metric = (narsil_metric)walk->field->metric;
    walk->codes.code_bytes = (uint32_t)code_bytes;
    for (uint32_t at = 0; at < dimension; at++) {
      double value = (double)walk->field->centroid[at];
      walk->codes.centroid_dot += value * value;
    }
    prepare_code(walk->workspace, &walk->code_store, walk->codes.metric, walk->request->query, &walk->codes.code);
  }
  return NARSIL_OK;
}

static int entry_of(const narsil_paged_vector_field *field, uint32_t *entry) {
  if (field->has_entry_point && paged_levels(field, field->entry_point) != 0) {
    *entry = field->entry_point;
    return 1;
  }
  uint8_t highest = 0;
  for (uint32_t ordinal = 0; ordinal < field->total; ordinal++) {
    uint8_t levels = paged_levels(field, ordinal);
    if (levels > highest) {
      highest = levels;
      *entry = ordinal;
    }
  }
  return highest != 0;
}

static int compare_scores(const void *lhs, const void *rhs) {
  const paged_candidate *first = lhs;
  const paged_candidate *second = rhs;
  int order = score_order(first->distance, second->distance);
  if (order != 0) { return order; }
  return first->ordinal < second->ordinal ? -1 : first->ordinal > second->ordinal;
}

static double score_of(double distance, uint32_t metric) {
  if (metric == NARSIL_METRIC_DOT_PRODUCT) { return -distance; }
  return metric == NARSIL_METRIC_COSINE ? 1 - distance : 1 / (1 + distance);
}

static narsil_status rank(paged_walk *walk, uint32_t *count) {
  paged_vector_scratch *scratch = walk->scratch;
  size_t found = scratch->found.size;
  for (size_t at = found; at > 0; at--) { scratch->ranked[at - 1] = paged_heap_pop(&scratch->found); }
  uint32_t kept = 0;
  for (size_t at = 0; at < found; at++) {
    paged_candidate candidate = scratch->ranked[at];
    if (walk->field->bits != 0) {
      if (at < walk->request->rescore_depth) {
        narsil_status status = paged_vector_distance(walk, candidate.ordinal, &candidate.distance, 1);
        if (status != NARSIL_OK) { return status; }
      } else if (!walk->request->explicit_rescore_window || walk->request->min_similarity != -HUGE_VAL) {
        break;
      }
    }
    candidate.distance = score_of(candidate.distance, walk->field->metric);
    if (candidate.distance < walk->request->min_similarity) { continue; }
    scratch->ranked[kept++] = candidate;
  }
  if (kept > 1) { qsort(scratch->ranked, kept, sizeof *scratch->ranked, compare_scores); }
  if (kept > walk->request->k) {
    uint32_t end = walk->request->k;
    double cutoff = scratch->ranked[end - 1].distance;
    while (end < kept && score_order(scratch->ranked[end].distance, cutoff) == 0) { end++; }
    kept = end;
  }
  *count = kept;
  return NARSIL_OK;
}

static narsil_status search(paged_walk *walk, uint32_t *count) {
  uint32_t entry = 0;
  *count = 0;
  if (walk->request->k == 0 || walk->field->total == 0 || !entry_of(walk->field, &entry)) { return NARSIL_OK; }
  narsil_status status = prepare(walk);
  if (status != NARSIL_OK) { return status; }
  uint32_t layer = (uint32_t)paged_levels(walk->field, entry) - 1;
  for (; layer > 0; layer--) {
    status = paged_walk_layer(walk, entry, (paged_layer){1, layer});
    if (status != NARSIL_OK) { return status; }
    if (walk->scratch->found.size > 0) { entry = walk->scratch->found.entries[0].ordinal; }
  }
  status = paged_walk_layer(walk, entry, (paged_layer){walk->request->ef, 0});
  return status == NARSIL_OK ? rank(walk, count) : status;
}

narsil_status narsil_search_paged_vectors(narsil_workspace *workspace, narsil_page_cache *cache,
                                          const narsil_paged_vector_field *field,
                                          const narsil_paged_vector_request *request,
                                          const narsil_paged_vector_output *output, uint32_t *count,
                                          narsil_page_fault *fault) {
  segment_regions regions = {0};
  if (workspace == NULL || !paged_vector_regions(&regions, cache, field, request, output, count, fault)) {
    return NARSIL_INVALID_ARGUMENT;
  }
  narsil_status status = paged_vector_validate(&regions, field, request, fault);
  if (status != NARSIL_OK) { return status; }
  paged_walk walk = {0};
  walk.workspace = workspace;
  walk.cache = cache;
  walk.field = field;
  walk.request = request;
  walk.fault = fault;
  walk.scratch = workspace_paged_vector_scratch(workspace);
  status = work_tally_begin(&walk.work, &request->meter);
  if (status != NARSIL_OK) { return status; }
  uint32_t found = 0;
  status = search(&walk, &found);
  narsil_status metered = work_tally_flush(&walk.work);
  if (status != NARSIL_OK) { return status; }
  if (metered != NARSIL_OK) { return metered; }
  if (found > output->ordinal_capacity || found > output->score_capacity) { return NARSIL_NEEDS_ROOM; }
  for (uint32_t at = 0; at < found; at++) {
    output->ordinals[at] = walk.scratch->ranked[at].ordinal;
    output->scores[at] = walk.scratch->ranked[at].distance;
  }
  *count = found;
  return NARSIL_OK;
}
