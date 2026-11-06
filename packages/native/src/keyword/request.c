#include "pass.h"
#include "score.h"
#include "scratch.h"

#include "../internal.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_keyword.h"

#include <stddef.h>
#include <stdint.h>

#define KNOWN_LIST_FLAGS (NARSIL_KEYWORD_LIST_FROM_ROWS | NARSIL_KEYWORD_LIST_ORDERED)
#define MAX_SLOT_TERM 0xFFFFU

typedef struct {
  keyword_needs *needs;
  keyword_pass *pass;
  uint64_t total_rows;
} request_check;

static int read_limit(double limit, keyword_pass *pass) {
  pass->has_limit = 0;
  pass->limit = 0;
  if (limit == NARSIL_KEYWORD_NO_LIMIT || limit != limit) { return 1; }
  if (!(limit >= 0)) { return 0; }
  pass->has_limit = 1;
  if (limit >= (double)UINT32_MAX) {
    pass->limit = UINT32_MAX;
    return 1;
  }
  pass->limit = (uint32_t)limit;
  return (double)pass->limit == limit;
}

static int rows_are_present(const narsil_keyword_request *request) {
  if (request->pool_length > 0 &&
      (request->pool_doc_ids == NULL || request->pool_frequencies == NULL || request->pool_fields == NULL)) {
    return 0;
  }
  return request->row_length == 0 ||
         (request->row_doc_ids != NULL && request->row_frequencies != NULL && request->row_fields != NULL);
}

static int bitsets_are_present(const narsil_keyword_request *request) {
  if (request->live_words > 0 && request->live == NULL) { return 0; }
  if (request->removed_words > 0 && request->removed == NULL) { return 0; }
  return !request->has_filter || request->filter_words == 0 || request->filter != NULL;
}

static int fields_are_present(const narsil_keyword_request *request) {
  uint32_t count = request->field_count;
  if (count > NARSIL_KEYWORD_MAX_FIELDS) { return 0; }
  if (count == 0) { return 1; }
  if (request->searchable == NULL || request->partial_marks == NULL || request->name_ranks == NULL ||
      request->field_numbers == NULL || request->lengths == NULL) {
    return 0;
  }
  for (uint32_t field = 0; field < count; field++) {
    if (request->lengths[field].length > 0 && request->lengths[field].values == NULL) { return 0; }
  }
  return 1;
}

static int slots_are_valid(const narsil_keyword_request *request, request_check *check) {
  if (request->slot_count > request->slot_capacity || (request->slot_count > 0 && request->slots == NULL)) { return 0; }
  uint32_t list_from = 0;
  uint32_t value_from = 0;
  for (uint32_t slot = 0; slot < request->slot_count; slot++) {
    const uint32_t *words = request->slots + ((size_t)slot * NARSIL_KEYWORD_SLOT_STRIDE);
    uint32_t kind = words[NARSIL_KEYWORD_SLOT_KIND];
    uint32_t list_end = words[NARSIL_KEYWORD_SLOT_LIST_END];
    uint32_t value_end = words[NARSIL_KEYWORD_SLOT_VALUE_END];
    if (kind > NARSIL_KEYWORD_PHRASE_SLOT || words[NARSIL_KEYWORD_SLOT_TERM] > MAX_SLOT_TERM || list_end < list_from ||
        list_end > request->list_capacity || value_end < value_from || value_end > request->slot_value_capacity) {
      return 0;
    }
    if (kind == NARSIL_KEYWORD_GROUP_SLOT) {
      if (value_end == value_from) { return 0; }
      check->needs->groups = 1;
    }
    list_from = list_end;
    value_from = value_end;
  }
  if (value_from > 0 && request->slot_values == NULL) { return 0; }
  check->pass->list_count = list_from;
  return 1;
}

static int lists_are_valid(const narsil_keyword_request *request, request_check *check) {
  uint32_t list_count = check->pass->list_count;
  if (list_count > 0 && (request->lists == NULL || request->list_values == NULL)) { return 0; }
  uint32_t longest = 0;
  for (uint32_t list = 0; list < list_count; list++) {
    uint32_t flags = keyword_list_flags(request, list);
    uint32_t start = keyword_list_start(request, list);
    uint32_t length = keyword_list_length(request, list);
    uint32_t rows = (flags & NARSIL_KEYWORD_LIST_FROM_ROWS) != 0 ? request->row_length : request->pool_length;
    if ((flags & ~KNOWN_LIST_FLAGS) != 0 || start > rows || length > rows - start) { return 0; }
    if (length > longest) { longest = length; }
    check->total_rows += length;
  }
  check->needs->order = longest;
  check->needs->lists = list_count;
  return 1;
}

static int output_is_valid(const narsil_keyword_request *request, const narsil_keyword_output *output) {
  uint32_t capacity = request->capacity;
  if (capacity > (uint32_t)INT32_MAX || capacity > output->length) { return 0; }
  if (output->length > 0 && (output->ordinals == NULL || output->scores == NULL)) { return 0; }
  uint32_t words = keyword_words_for(capacity);
  return !request->collect || (output->matched_words >= words && (words == 0 || output->matched != NULL));
}

static void load_pass(const narsil_keyword_request *request, request_check *check) {
  keyword_pass *pass = check->pass;
  keyword_needs *needs = check->needs;
  uint32_t count = request->field_count;
  const double *numbers = request->field_numbers;
  pass->request = request;
  pass->field_count = count;
  pass->capacity = request->capacity;
  pass->boosts = numbers == NULL ? NULL : numbers + ((size_t)NARSIL_KEYWORD_FIELD_BOOSTS * count);
  pass->averages = numbers == NULL ? NULL : numbers + ((size_t)NARSIL_KEYWORD_FIELD_AVERAGE_LENGTHS * count);
  pass->k1s = numbers == NULL ? NULL : numbers + ((size_t)NARSIL_KEYWORD_FIELD_K1 * count);
  pass->bs = numbers == NULL ? NULL : numbers + ((size_t)NARSIL_KEYWORD_FIELD_B * count);
  double terms = request->terms;
  double required = request->term_match > 0 && terms > 0 ? request->term_match : 0;
  pass->tracks_coverage = required > 0 && required <= terms;
  needs->coverage = pass->tracks_coverage;
  needs->capacity = request->capacity;
  needs->selection = pass->has_limit && pass->limit < request->capacity ? pass->limit : request->capacity;
}

static void build_scorable(keyword_pass *pass, uint32_t *bits) {
  const narsil_keyword_request *request = pass->request;
  uint32_t words = keyword_words_for(pass->capacity);
  for (uint32_t word = 0; word < words; word++) {
    uint32_t value = word < request->live_words ? request->live[word] : 0;
    if (word < request->removed_words) { value &= ~request->removed[word]; }
    if (request->has_filter) { value &= word < request->filter_words ? request->filter[word] : 0; }
    bits[word] = value;
  }
  uint32_t tail = pass->capacity & KEYWORD_BIT_MASK;
  if (tail != 0) { bits[words - 1] &= (1U << tail) - 1U; }
  pass->scorable_bits = bits;
  pass->scorable_words = words;
}

static int request_is_valid(const narsil_keyword_request *request, const narsil_keyword_output *output,
                            request_check *check) {
  return read_limit(request->limit, check->pass) && rows_are_present(request) && bitsets_are_present(request) &&
         fields_are_present(request) && slots_are_valid(request, check) && lists_are_valid(request, check) &&
         output_is_valid(request, output);
}

narsil_status narsil_keyword_score(narsil_workspace *workspace, const narsil_keyword_request *request,
                                   narsil_keyword_output *output) {
  if (workspace == NULL || request == NULL || output == NULL) { return NARSIL_INVALID_ARGUMENT; }
  keyword_needs needs = {0, 0, 0, 0, 0, 0};
  keyword_pass pass = {0};
  request_check check = {&needs, &pass, 0};
  output->count = 0;
  output->total_matched = 0;
  output->scoring_path = NARSIL_KEYWORD_SCORED_IN_FULL;
  if (!request_is_valid(request, output, &check)) { return NARSIL_INVALID_ARGUMENT; }
  load_pass(request, &check);
  keyword_scratch *scratch = workspace_keyword_scratch(workspace);
  narsil_status status = keyword_reserve(scratch, &needs);
  if (status != NARSIL_OK) { return status; }
  pass.scratch = scratch;
  pass.output = output;
  if (pass.capacity > 0 && keyword_words_for(pass.capacity) <= check.total_rows) {
    build_scorable(&pass, scratch->scorable);
  }
  if (keyword_score_pruned(&pass) == KEYWORD_NOT_PRUNED) { keyword_score_every_slot(&pass); }
  return NARSIL_OK;
}
