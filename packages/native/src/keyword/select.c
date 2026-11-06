#include "select.h"

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
  if (heap->scores[lhs] != heap->scores[rhs]) { return heap->scores[lhs] < heap->scores[rhs]; }
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

static uint32_t offer_score(double *selection, uint32_t size, uint32_t limit, double score) {
  if (size == limit && !(score > selection[0])) { return size; }
  uint32_t node = 0;
  uint32_t grown = size;
  if (size < limit) {
    node = grown++;
    while (node > 0) {
      uint32_t parent = (node - 1) / 2;
      if (!(selection[parent] > score)) { break; }
      selection[node] = selection[parent];
      node = parent;
    }
  } else {
    for (;;) {
      uint64_t left = (2 * (uint64_t)node) + 1;
      if (left >= size) { break; }
      uint64_t right = left + 1;
      uint64_t child = right < size && selection[right] < selection[left] ? right : left;
      if (!(selection[child] < score)) { break; }
      selection[node] = selection[child];
      node = (uint32_t)child;
    }
  }
  selection[node] = score;
  return grown;
}

static double limit_best_score(const keyword_pass *pass, uint32_t kept) {
  double *selection = pass->scratch->selection;
  const double *scores = pass->output->scores;
  uint32_t size = 0;
  for (uint32_t index = 0; index < kept; index++) { size = offer_score(selection, size, pass->limit, scores[index]); }
  return selection[0];
}

double keyword_touched_best_score(const keyword_pass *pass) {
  const keyword_scratch *scratch = pass->scratch;
  double *selection = scratch->selection;
  uint32_t size = 0;
  for (uint32_t index = 0; index < scratch->touched_count; index++) {
    size = offer_score(selection, size, pass->limit, scratch->scores[scratch->touched[index]]);
  }
  return selection[0];
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
        if (!(scores[index] >= lowest)) { continue; }
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
