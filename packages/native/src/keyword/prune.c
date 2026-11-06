#include "pass.h"
#include "rows.h"
#include "score.h"
#include "scratch.h"
#include "select.h"

#include "../../include/narsil_keyword.h"

#include <float.h>
#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#define PRUNING_SLACK 1e-9
#define PRUNING_MAX_ROWS_PER_DOCUMENT 100000U

typedef struct {
  uint32_t *order;
  const double *bounds;
  uint32_t size;
} list_heap;

typedef struct {
  double row_weight;
  uint32_t rows_per_document;
} field_ceiling;

typedef struct {
  uint32_t rows_per_document;
  uint32_t exceeded;
} row_check;

static int fields_keep_scores_non_negative(const keyword_pass *pass, field_ceiling *ceiling) {
  ceiling->row_weight = 0;
  ceiling->rows_per_document = 0;
  for (uint32_t field = 0; field < pass->field_count; field++) {
    if (!keyword_searchable(pass, field)) { continue; }
    ceiling->rows_per_document++;
    double boost = pass->boosts[field];
    double average = pass->averages[field];
    double saturation = pass->k1s[field];
    double length_weight = pass->bs[field];
    if (!(boost >= 0 && boost <= DBL_MAX) || !(average >= 0 && average <= DBL_MAX) ||
        !(saturation >= 0 && saturation <= DBL_MAX) || !(length_weight >= 0 && length_weight <= 1)) {
      return 0;
    }
    double weight = (saturation + 1) * boost;
    if (weight > ceiling->row_weight) { ceiling->row_weight = weight; }
  }
  return ceiling->rows_per_document > 0;
}

static int prunable(const keyword_pass *pass, field_ceiling *ceiling) {
  const narsil_keyword_request *request = pass->request;
  if (!pass->has_limit || pass->limit < 1 || request->min_score > 0) { return 0; }
  if (request->terms > 0 && (request->term_match > 1 || request->term_match > request->terms)) { return 0; }
  if (pass->list_count < 2 || pass->scorable_bits == NULL) { return 0; }
  for (uint32_t slot = 0; slot < request->slot_count; slot++) {
    uint32_t kind = request->slots[((size_t)slot * NARSIL_KEYWORD_SLOT_STRIDE) + NARSIL_KEYWORD_SLOT_KIND];
    if (kind != NARSIL_KEYWORD_TERM_SLOT) { return 0; }
  }
  for (uint32_t list = 0; list < pass->list_count; list++) {
    uint32_t flags = keyword_list_flags(request, list);
    if ((flags & NARSIL_KEYWORD_LIST_FROM_ROWS) != 0 || (flags & NARSIL_KEYWORD_LIST_ORDERED) == 0) { return 0; }
  }
  if ((uint64_t)pass->list_count * pass->field_count > PRUNING_MAX_ROWS_PER_DOCUMENT) { return 0; }
  return fields_keep_scores_non_negative(pass, ceiling);
}

static int list_before(const list_heap *heap, uint32_t lhs, uint32_t rhs) {
  if (heap->bounds[lhs] != heap->bounds[rhs]) { return heap->bounds[lhs] > heap->bounds[rhs]; }
  return lhs < rhs;
}

static void sift_list_down(const list_heap *heap, uint32_t root) {
  uint32_t *order = heap->order;
  uint32_t node = root;
  for (;;) {
    uint64_t left = (2 * (uint64_t)node) + 1;
    if (left >= heap->size) { return; }
    uint64_t last = node;
    if (list_before(heap, order[last], order[left])) { last = left; }
    if (left + 1 < heap->size && list_before(heap, order[last], order[left + 1])) { last = left + 1; }
    if (last == node) { return; }
    uint32_t held = order[node];
    order[node] = order[last];
    order[last] = held;
    node = (uint32_t)last;
  }
}

static void sort_lists_by_bound(keyword_scratch *scratch, uint32_t count) {
  list_heap heap = {scratch->list_order, scratch->list_bounds, count};
  for (uint32_t root = count / 2; root > 0; root--) { sift_list_down(&heap, root - 1); }
  for (uint32_t size = count; size > 1; size--) {
    uint32_t held = heap.order[0];
    heap.order[0] = heap.order[size - 1];
    heap.order[size - 1] = held;
    heap.size = size - 1;
    sift_list_down(&heap, 0);
  }
}

static uint32_t next_run(uint32_t run, uint32_t ordinal, uint32_t previous) {
  return (run & ((uint32_t)0 - (uint32_t)(ordinal == previous))) + 1U;
}

static void score_every_row(const keyword_pass *pass, uint32_t list, row_check *check) {
  const narsil_keyword_request *request = pass->request;
  keyword_scratch *scratch = pass->scratch;
  const uint32_t *doc_ids = request->pool_doc_ids;
  const uint16_t *fields = request->pool_fields;
  const uint16_t *frequencies = request->pool_frequencies;
  uint32_t start = keyword_list_start(request, list);
  uint32_t end = start + keyword_list_length(request, list);
  double idf = scratch->list_idfs[list];
  const uint32_t *scorable = pass->scorable_bits;
  uint32_t *seen_bits = scratch->seen_bits;
  double *scores = scratch->scores;
  uint32_t *touched = scratch->touched;
  uint32_t touched_count = scratch->touched_count;
  uint32_t rows_per_document = check->rows_per_document;
  uint32_t exceeded = 0;
  uint32_t previous = UINT32_MAX;
  uint32_t run = 0;
  for (uint32_t row = start; row < end; row++) {
    uint16_t field = fields[row];
    uint32_t ordinal = doc_ids[row];
    if (!keyword_searchable(pass, field) || ordinal >= pass->capacity) { continue; }
    run = next_run(run, ordinal, previous);
    previous = ordinal;
    exceeded |= (uint32_t)(run > rows_per_document);
    double score = keyword_row_score(pass, idf, (double)frequencies[row], field, ordinal);
    uint32_t word = ordinal >> KEYWORD_WORD_SHIFT;
    uint32_t shift = ordinal & KEYWORD_BIT_MASK;
    uint32_t seen = (seen_bits[word] >> shift) & 1U;
    uint32_t fresh = ((scorable[word] & ~seen_bits[word]) >> shift) & 1U;
    seen_bits[word] |= fresh << shift;
    scores[ordinal] = keyword_kept_or_zero(scores[ordinal], seen) + score;
    touched[touched_count] = ordinal;
    touched_count += fresh;
  }
  scratch->touched_count = touched_count;
  check->exceeded |= exceeded;
}

static uint32_t score_known_rows(const keyword_pass *pass, uint32_t list, row_check *check) {
  const narsil_keyword_request *request = pass->request;
  keyword_scratch *scratch = pass->scratch;
  const uint32_t *doc_ids = request->pool_doc_ids;
  const uint16_t *fields = request->pool_fields;
  const uint16_t *frequencies = request->pool_frequencies;
  uint32_t start = keyword_list_start(request, list);
  uint32_t end = start + keyword_list_length(request, list);
  double idf = scratch->list_idfs[list];
  const uint32_t *scorable = pass->scorable_bits;
  const uint32_t *seen_bits = scratch->seen_bits;
  uint32_t *counted_bits = scratch->counted_bits;
  double *scores = scratch->scores;
  uint32_t *matched = request->collect ? pass->output->matched : NULL;
  uint32_t counted = 0;
  uint32_t *seen_rows = scratch->order;
  uint32_t seen_count = 0;
  uint32_t rows_per_document = check->rows_per_document;
  uint32_t exceeded = 0;
  uint32_t previous = UINT32_MAX;
  uint32_t run = 0;
  for (uint32_t row = start; row < end; row++) {
    uint16_t field = fields[row];
    uint32_t ordinal = doc_ids[row];
    if (!keyword_searchable(pass, field) || ordinal >= pass->capacity) { continue; }
    run = next_run(run, ordinal, previous);
    previous = ordinal;
    exceeded |= (uint32_t)(run > rows_per_document);
    uint32_t word = ordinal >> KEYWORD_WORD_SHIFT;
    uint32_t shift = ordinal & KEYWORD_BIT_MASK;
    uint32_t seen = (seen_bits[word] >> shift) & 1U;
    uint32_t fresh = ((scorable[word] & ~(seen_bits[word] | counted_bits[word])) >> shift) & 1U;
    counted_bits[word] |= fresh << shift;
    if (matched != NULL) { matched[word] |= fresh << shift; }
    counted += fresh;
    seen_rows[seen_count] = row;
    seen_count += seen;
  }
  for (uint32_t place = 0; place < seen_count; place++) {
    uint32_t row = seen_rows[place];
    uint32_t ordinal = doc_ids[row];
    uint16_t field = fields[row];
    scores[ordinal] += keyword_row_score(pass, idf, (double)frequencies[row], field, ordinal);
  }
  check->exceeded |= exceeded;
  return counted;
}

static uint32_t first_row_of(const uint32_t *doc_ids, uint32_t begin, uint32_t end, uint32_t ordinal) {
  if (begin >= end) { return begin; }
  uint32_t low = begin;
  uint32_t length = end - begin;
  while (length > 1) {
    uint32_t half = length / 2;
    low = doc_ids[low + half - 1] < ordinal ? low + half : low;
    length -= half;
  }
  return low + (uint32_t)(doc_ids[low] < ordinal);
}

static double exact_score(const keyword_pass *pass, const keyword_row_keys *keys, uint32_t ordinal) {
  const narsil_keyword_request *request = pass->request;
  const uint16_t *frequencies = request->pool_frequencies;
  double score = 0;
  for (uint32_t list = 0; list < pass->list_count; list++) {
    uint32_t start = keyword_list_start(request, list);
    uint32_t end = start + keyword_list_length(request, list);
    uint32_t first = first_row_of(keys->doc_ids, start, end, ordinal);
    uint32_t last = first;
    while (last < end && keys->doc_ids[last] == ordinal) { last++; }
    if (last == first) { continue; }
    double idf = pass->scratch->list_idfs[list];
    const uint32_t *rows = keyword_rank_ordered_run(pass, keys, first, last - first);
    for (uint32_t place = 0; place < last - first; place++) {
      uint32_t row = rows[place];
      uint32_t field = keys->fields[row];
      if (keyword_searchable(pass, field)) {
        score += keyword_row_score(pass, idf, (double)frequencies[row], field, ordinal);
      }
    }
  }
  return score;
}

static uint32_t score_essential_lists(const keyword_pass *pass, row_check *check) {
  keyword_scratch *scratch = pass->scratch;
  const double *remaining_bounds = scratch->remaining_bounds;
  uint32_t essential = 0;
  int checked = 0;
  double threshold_ceiling = 0;
  for (; essential < pass->list_count; essential++) {
    double remaining = remaining_bounds[essential];
    if (essential > 0 && scratch->touched_count >= pass->limit && remaining < remaining_bounds[0] - remaining &&
        (!checked || 2 * remaining < threshold_ceiling)) {
      double threshold = keyword_touched_best_score(pass);
      if (remaining * (1 + PRUNING_SLACK) < threshold * (1 - PRUNING_SLACK)) { break; }
      checked = 1;
      threshold_ceiling = threshold + remaining;
    }
    score_every_row(pass, scratch->list_order[essential], check);
  }
  return essential;
}

static int order_lists(const keyword_pass *pass, const field_ceiling *ceiling, uint64_t *total_rows) {
  const narsil_keyword_request *request = pass->request;
  keyword_scratch *scratch = pass->scratch;
  uint32_t list_count = pass->list_count;
  double document_ceiling = ceiling->row_weight * (double)ceiling->rows_per_document;
  for (uint32_t list = 0; list < list_count; list++) {
    double idf = keyword_idf(keyword_list_value(request, list, NARSIL_KEYWORD_LIST_DOCUMENT_FREQUENCY),
                             request->total_documents);
    if (!(idf >= 0 && idf <= DBL_MAX)) { return 0; }
    *total_rows += keyword_list_length(request, list);
    scratch->list_idfs[list] = idf;
    scratch->list_bounds[list] = idf * document_ceiling;
    scratch->list_order[list] = list;
  }
  sort_lists_by_bound(scratch, list_count);
  double *remaining = scratch->remaining_bounds;
  remaining[list_count] = 0;
  for (uint32_t place = list_count; place > 0; place--) {
    remaining[place - 1] = remaining[place] + scratch->list_bounds[scratch->list_order[place - 1]];
  }
  return remaining[0] <= DBL_MAX;
}

static uint32_t score_in_full_after_pruning(const keyword_pass *pass) {
  pass->output->scoring_path = NARSIL_KEYWORD_PRUNED_THEN_FULL;
  return keyword_score_every_slot(pass);
}

static void mark_touched(const keyword_pass *pass) {
  const keyword_scratch *scratch = pass->scratch;
  for (uint32_t index = 0; index < scratch->touched_count; index++) {
    keyword_mark_matched(pass->output->matched, scratch->touched[index]);
  }
}

uint32_t keyword_score_pruned(const keyword_pass *pass) {
  field_ceiling ceiling;
  if (!prunable(pass, &ceiling)) { return KEYWORD_NOT_PRUNED; }
  const narsil_keyword_request *request = pass->request;
  keyword_scratch *scratch = pass->scratch;
  narsil_keyword_output *output = pass->output;
  uint64_t total_rows = 0;
  if (!order_lists(pass, &ceiling, &total_rows)) { return KEYWORD_NOT_PRUNED; }
  size_t bitset_bytes = (size_t)pass->scorable_words * sizeof *scratch->seen_bits;
  memset(scratch->seen_bits, 0, bitset_bytes);
  memset(scratch->counted_bits, 0, bitset_bytes);
  scratch->touched_count = 0;
  row_check check = {ceiling.rows_per_document, 0};
  uint32_t essential = score_essential_lists(pass, &check);
  if (request->collect) { keyword_clear_matched(pass); }
  uint32_t counted = 0;
  for (uint32_t rest = essential; rest < pass->list_count; rest++) {
    counted += score_known_rows(pass, scratch->list_order[rest], &check);
  }
  if (check.exceeded) { return score_in_full_after_pruning(pass); }
  if (request->collect) { mark_touched(pass); }
  double floor =
      scratch->touched_count > pass->limit ? keyword_touched_best_score(pass) * (1 - PRUNING_SLACK) : -HUGE_VAL;
  uint32_t candidates = 0;
  for (uint32_t index = 0; index < scratch->touched_count; index++) {
    uint32_t ordinal = scratch->touched[index];
    if (scratch->scores[ordinal] >= floor) { output->ordinals[candidates++] = (int32_t)ordinal; }
  }
  if ((uint64_t)candidates * pass->list_count > total_rows) { return score_in_full_after_pruning(pass); }
  keyword_row_keys keys;
  keyword_list_keys(pass, 0, &keys);
  for (uint32_t place = 0; place < candidates; place++) {
    output->scores[place] = exact_score(pass, &keys, (uint32_t)output->ordinals[place]);
  }
  output->total_matched = scratch->touched_count + counted;
  output->scoring_path = NARSIL_KEYWORD_PRUNED;
  return keyword_keep_best(pass, candidates);
}
