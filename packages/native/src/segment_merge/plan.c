#include "internal.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_segment_merge.h"
#include "../segments/postings.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

enum { MERGE_WORD_BITS = 32, MERGE_FIELD_WORDS = 2048 };

static narsil_status mappings(segment_merge_scratch *scratch, const narsil_keyword_merge_request *request) {
  size_t words = request->document_count == 0 ? 1 : (((size_t)request->document_count - 1) / MERGE_WORD_BITS) + 1;
  void *allocation = scratch->mapped;
  narsil_status status = segment_merge_reserve(&allocation, words, &scratch->mapped_capacity, sizeof *scratch->mapped);
  scratch->mapped = allocation;
  if (status != NARSIL_OK) { return status; }
  memset(scratch->mapped, 0, words * sizeof *scratch->mapped);
  uint32_t mapped_count = 0;
  for (size_t at = 0; at < request->input_count; at++) {
    const narsil_keyword_merge_input *input = request->inputs + at;
    uint32_t fields[MERGE_FIELD_WORDS] = {0};
    for (size_t field = 0; field < input->field_count; field++) {
      uint32_t target = input->field_mapping[field];
      uint32_t mask = UINT32_C(1) << (target % MERGE_WORD_BITS);
      if (target >= request->field_count || (fields[target / MERGE_WORD_BITS] & mask) != 0) {
        return NARSIL_INVALID_ARGUMENT;
      }
      fields[target / MERGE_WORD_BITS] |= mask;
    }
    for (size_t ordinal = 0; ordinal < input->document_count; ordinal++) {
      uint32_t target = input->mapping[ordinal];
      if (target == UINT32_MAX) { continue; }
      if (input->growing != NULL && segment_row_removed(input->growing, (uint32_t)ordinal)) {
        return NARSIL_INVALID_ARGUMENT;
      }
      if (target >= request->document_count) { return NARSIL_INVALID_ARGUMENT; }
      uint32_t mask = UINT32_C(1) << (target % MERGE_WORD_BITS);
      if ((scratch->mapped[target / MERGE_WORD_BITS] & mask) != 0) { return NARSIL_INVALID_ARGUMENT; }
      scratch->mapped[target / MERGE_WORD_BITS] |= mask;
      mapped_count++;
    }
  }
  return mapped_count == request->document_count ? NARSIL_OK : NARSIL_INVALID_ARGUMENT;
}

static int order_terms(const merge_term *first, const merge_term *second) {
  int order = segment_merge_compare_text(first->text, second->text);
  if (order != 0) { return order; }
  if (first->source != second->source) { return first->source < second->source ? -1 : 1; }
  return first->ordinal < second->ordinal ? -1 : first->ordinal > second->ordinal;
}

static int compare_terms(const void *left, const void *right) { return order_terms(left, right); }

static narsil_status collect_terms(segment_merge_scratch *scratch, const narsil_keyword_merge_request *request) {
  size_t count = 0;
  for (size_t at = 0; at < request->input_count; at++) {
    size_t added = segment_merge_term_count(request->inputs + at);
    if (added > SIZE_MAX - count) { return NARSIL_OUT_OF_MEMORY; }
    count += added;
  }
  void *allocation = scratch->terms;
  narsil_status status = segment_merge_reserve(&allocation, count, &scratch->term_capacity, sizeof *scratch->terms);
  scratch->terms = allocation;
  if (status != NARSIL_OK) { return status; }
  status = segment_merge_reserve_text(scratch, request);
  if (status != NARSIL_OK) { return status; }
  scratch->term_count = 0;
  for (size_t at = 0; at < request->input_count; at++) {
    const narsil_keyword_merge_input *input = request->inputs + at;
    if (input->growing == NULL ? input->position_offsets != NULL : input->growing->positions != NULL) {
      scratch->sizes.has_positions = 1;
    }
    uint32_t terms = segment_merge_term_count(input);
    for (uint32_t ordinal = 0; ordinal < terms; ordinal++) {
      merge_term term = {.input = input, .ordinal = ordinal, .source = at, .target = UINT32_MAX};
      int found = segment_merge_source_term(scratch, input, ordinal, &term);
      if (found < 0) { return NARSIL_INVALID_ARGUMENT; }
      if (found > 0) { scratch->terms[scratch->term_count++] = term; }
    }
  }
  if (scratch->term_count > 1) { qsort(scratch->terms, scratch->term_count, sizeof *scratch->terms, compare_terms); }
  return NARSIL_OK;
}

static narsil_status measure_postings(segment_merge_scratch *scratch) {
  for (size_t start = 0; start < scratch->term_count;) {
    size_t end = start + 1;
    while (end < scratch->term_count &&
           segment_merge_compare_text(scratch->terms[start].text, scratch->terms[end].text) == 0) {
      end++;
    }
    narsil_status status = segment_merge_rows(scratch, start, end);
    if (status != NARSIL_OK) { return status; }
    if (scratch->row_count > 0) {
      size_t bytes = scratch->terms[start].text.length;
      if (scratch->sizes.terms == UINT32_MAX || bytes > UINT32_MAX - scratch->sizes.term_bytes ||
          scratch->row_count > UINT32_MAX - scratch->sizes.postings) {
        return NARSIL_INVALID_ARGUMENT;
      }
      for (size_t at = start; at < end; at++) { scratch->terms[at].target = scratch->sizes.terms; }
      scratch->sizes.terms++;
      scratch->sizes.term_bytes += (uint32_t)bytes;
      scratch->sizes.postings += (uint32_t)scratch->row_count;
      for (size_t at = 0; at < scratch->row_count; at++) {
        uint32_t positions = scratch->rows[at].position_count;
        if (positions > UINT32_MAX - scratch->sizes.positions) { return NARSIL_INVALID_ARGUMENT; }
        scratch->sizes.positions += positions;
      }
    }
    start = end;
  }
  return NARSIL_OK;
}

narsil_status segment_merge_prepare(segment_merge_scratch *scratch, const narsil_keyword_merge_request *request) {
  scratch->sizes = (narsil_keyword_merge_sizes){0};
  narsil_status status = mappings(scratch, request);
  if (request->retained_terms != NULL) {
    if (status == NARSIL_OK) { status = segment_merge_retained(scratch, request); }
    return status == NARSIL_OK ? segment_merge_strings(scratch, request) : status;
  }
  if (status == NARSIL_OK) { status = collect_terms(scratch, request); }
  if (status == NARSIL_OK) { status = measure_postings(scratch); }
  if (status == NARSIL_OK) { status = segment_merge_strings(scratch, request); }
  return status;
}
