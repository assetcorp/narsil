#include "select.h"

#include "../score_order.h"
#include "pass.h"
#include "scratch.h"

#include "../../include/narsil_keyword.h"

#include <stdint.h>

typedef struct {
  int32_t *ordinals;
  double *scores;
  uint32_t size;
} best_heap;

static int ranks_below(const best_heap *heap, uint64_t lhs, uint64_t rhs) {
  int order = score_order(heap->scores[lhs], heap->scores[rhs]);
  if (order != 0) { return order > 0; }
  return heap->ordinals[lhs] > heap->ordinals[rhs];
}

static void swap_places(const best_heap *heap, uint32_t lhs, uint32_t rhs) {
  int32_t ordinal = heap->ordinals[lhs];
  heap->ordinals[lhs] = heap->ordinals[rhs];
  heap->ordinals[rhs] = ordinal;
  double score = heap->scores[lhs];
  heap->scores[lhs] = heap->scores[rhs];
  heap->scores[rhs] = score;
}

static void sift_best_down(const best_heap *heap, uint32_t root) {
  uint32_t node = root;
  for (;;) {
    uint64_t left = (2 * (uint64_t)node) + 1;
    if (left >= heap->size) { return; }
    uint64_t right = left + 1;
    uint64_t lowest = node;
    if (ranks_below(heap, left, lowest)) { lowest = left; }
    if (right < heap->size && ranks_below(heap, right, lowest)) { lowest = right; }
    if (lowest == node) { return; }
    swap_places(heap, node, (uint32_t)lowest);
    node = (uint32_t)lowest;
  }
}

static void sort_best_first(int32_t *ordinals, double *scores, uint32_t count) {
  best_heap heap = {ordinals, scores, count};
  for (uint32_t root = count / 2; root > 0; root--) { sift_best_down(&heap, root - 1); }
  for (uint32_t size = count; size > 1; size--) {
    swap_places(&heap, 0, size - 1);
    heap.size = size - 1;
    sift_best_down(&heap, 0);
  }
}

typedef struct {
  double *scores;
  uint32_t size;
  uint32_t limit;
} lowest_heap;

static void rise_score(lowest_heap *heap, double score) {
  double *scores = heap->scores;
  uint32_t node = heap->size++;
  while (node > 0) {
    uint32_t parent = (node - 1) / 2;
    if (!score_ranks_before(scores[parent], score)) { break; }
    scores[node] = scores[parent];
    node = parent;
  }
  scores[node] = score;
}

static void sink_score(const lowest_heap *heap, double score) {
  double *scores = heap->scores;
  uint32_t size = heap->size;
  uint32_t node = 0;
  for (;;) {
    uint64_t left = (2 * (uint64_t)node) + 1;
    if (left >= size) { break; }
    uint64_t right = left + 1;
    uint64_t child = right < size && score_ranks_before(scores[left], scores[right]) ? right : left;
    if (!score_ranks_before(score, scores[child])) { break; }
    scores[node] = scores[child];
    node = (uint32_t)child;
  }
  scores[node] = score;
}

static inline void offer_score(lowest_heap *heap, double score) {
  if (heap->size < heap->limit) {
    rise_score(heap, score);
    return;
  }
  if (heap->size > 0 && !score_ranks_before(score, heap->scores[0])) { return; }
  sink_score(heap, score);
}

static double limit_best_score(const keyword_pass *pass, uint32_t kept) {
  lowest_heap heap = {pass->scratch->selection, 0, pass->limit};
  const double *scores = pass->output->scores;
  for (uint32_t index = 0; index < kept; index++) { offer_score(&heap, scores[index]); }
  return heap.scores[0];
}

double keyword_touched_best_score(const keyword_pass *pass) {
  const keyword_scratch *scratch = pass->scratch;
  lowest_heap heap = {scratch->selection, 0, pass->limit};
  for (uint32_t index = 0; index < scratch->touched_count; index++) {
    offer_score(&heap, scratch->scores[scratch->touched[index]]);
  }
  return heap.scores[0];
}

void keyword_clear_matched(const keyword_pass *pass) {
  uint32_t words = keyword_words_for(pass->capacity);
  uint32_t *matched = pass->output->matched;
  for (uint32_t word = 0; word < words; word++) { matched[word] = 0; }
}

uint32_t keyword_keep_best(const keyword_pass *pass, uint32_t candidates) {
  narsil_keyword_output *output = pass->output;
  int32_t *ordinals = output->ordinals;
  double *scores = output->scores;
  uint32_t count = candidates;
  if (pass->has_limit && candidates > pass->limit) {
    count = 0;
    if (pass->limit > 0) {
      double lowest = limit_best_score(pass, candidates);
      for (uint32_t index = 0; index < candidates; index++) {
        if (score_ranks_before(lowest, scores[index])) { continue; }
        ordinals[count] = ordinals[index];
        scores[count] = scores[index];
        count++;
      }
    }
  }
  sort_best_first(ordinals, scores, count);
  output->count = count;
  return count;
}

uint32_t keyword_select_kept(const keyword_pass *pass) {
  const narsil_keyword_request *request = pass->request;
  const keyword_scratch *scratch = pass->scratch;
  narsil_keyword_output *output = pass->output;
  double terms = request->terms;
  double min_score = request->min_score;
  double required = request->term_match > 0 && terms > 0 ? request->term_match : 0;
  uint32_t kept = 0;
  if (required <= terms) {
    for (uint32_t index = 0; index < scratch->touched_count; index++) {
      uint32_t ordinal = scratch->touched[index];
      if (required > 0 && (double)scratch->covered[ordinal] < required) { continue; }
      double score = scratch->scores[ordinal];
      if (min_score > 0 && !(score >= min_score)) { continue; }
      output->ordinals[kept] = (int32_t)ordinal;
      output->scores[kept] = score;
      kept++;
    }
  }
  if (request->collect) {
    keyword_clear_matched(pass);
    for (uint32_t index = 0; index < kept; index++) {
      keyword_mark_matched(output->matched, (uint32_t)output->ordinals[index]);
    }
  }
  output->total_matched = kept;
  return keyword_keep_best(pass, kept);
}
