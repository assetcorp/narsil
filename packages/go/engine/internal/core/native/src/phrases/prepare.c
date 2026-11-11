#include "internal.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_phrases.h"
#include "../analysis/text.h"
#include "../work/constants.h"
#include "../work/tally.h"
#include "scratch.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

enum { RADIX_BITS = 8, RADIX_BUCKETS = 256 };

static narsil_status reserve(phrase_scratch *scratch, const narsil_phrase_request *request) {
  size_t rows = 0;
  size_t largest = request->phrase_count;
  for (size_t token = 0; token < request->token_count; token++) {
    size_t count = request->postings[token].count;
    if (count > UINT32_MAX - rows) { return NARSIL_OUT_OF_MEMORY; }
    rows += count;
    if (count > largest) { largest = count; }
  }
  size_t words = phrase_bitmap_words(request->ordinal_count);
  if (narsil_code_points_reserve(&scratch->token_starts, request->token_count) != NARSIL_OK ||
      narsil_code_points_reserve(&scratch->order, rows) != NARSIL_OK ||
      narsil_code_points_reserve(&scratch->spare, largest) != NARSIL_OK ||
      narsil_code_points_reserve(&scratch->leads, request->phrase_count) != NARSIL_OK ||
      narsil_code_points_reserve(&scratch->phrase_order, request->phrase_count) != NARSIL_OK ||
      narsil_code_points_reserve(&scratch->row_starts, request->phrase_count) != NARSIL_OK ||
      narsil_code_points_reserve(&scratch->row_counts, request->phrase_count) != NARSIL_OK ||
      narsil_code_points_reserve(&scratch->cursors, request->entry_count) != NARSIL_OK ||
      narsil_code_points_reserve(&scratch->ends, request->entry_count) != NARSIL_OK ||
      narsil_code_points_reserve(&scratch->position_rows, request->entry_count) != NARSIL_OK ||
      narsil_code_points_reserve(&scratch->matched, words) != NARSIL_OK ||
      narsil_code_points_reserve(&scratch->next, words) != NARSIL_OK) {
    return NARSIL_OUT_OF_MEMORY;
  }
  for (size_t token = 0; token < request->token_count; token++) { scratch->token_starts.values[token] = UINT32_MAX; }
  if (request->phrase_count > 0) {
    memset(scratch->row_starts.values, 0, request->phrase_count * sizeof(uint32_t));
    memset(scratch->row_counts.values, 0, request->phrase_count * sizeof(uint32_t));
  }
  memset(scratch->matched.values, 0, words * sizeof(uint32_t));
  return NARSIL_OK;
}

static narsil_status sort_rows(const narsil_phrase_postings *list, uint32_t *order, work_tally *tally,
                               uint32_t *spare) {
  if (work_tally_add(tally, list->count) != NARSIL_OK) { return tally->status; }
  uint32_t *from = order;
  uint32_t *into = spare;
  for (uint32_t shift = 0; shift < PHRASE_WORD_BITS; shift += RADIX_BITS) {
    uint32_t buckets[RADIX_BUCKETS] = {0};
    for (size_t row = 0; row < list->count; row++) { buckets[(list->documents[row] >> shift) & (RADIX_BUCKETS - 1)]++; }
    uint32_t next = 0;
    for (size_t digit = 0; digit < RADIX_BUCKETS; digit++) {
      uint32_t count = buckets[digit];
      buckets[digit] = next;
      next += count;
    }
    for (size_t at = 0; at < list->count; at++) {
      uint32_t row = from[at];
      into[buckets[(list->documents[row] >> shift) & (RADIX_BUCKETS - 1)]++] = row;
      if (at % NARSIL_WORK_FLUSH_UNITS == 0 && work_tally_flush(tally) != NARSIL_OK) { return tally->status; }
    }
    uint32_t *swap = from;
    from = into;
    into = swap;
  }
  return NARSIL_OK;
}

static size_t lead_count(const phrase_scratch *scratch, const narsil_phrase_request *request, uint32_t phrase) {
  return request->postings[request->tokens[scratch->leads.values[phrase]]].count;
}

static void merge_phrases(phrase_scratch *scratch, const narsil_phrase_request *request, size_t width) {
  size_t count = request->phrase_count;
  for (size_t start = 0; start < count;) {
    size_t middle = width < count - start ? start + width : count;
    size_t end = width < count - middle ? middle + width : count;
    size_t first = start;
    size_t second = middle;
    for (size_t into = start; into < end; into++) {
      int take_first =
          first < middle && (second == end || lead_count(scratch, request, scratch->phrase_order.values[first]) <=
                                                  lead_count(scratch, request, scratch->phrase_order.values[second]));
      scratch->spare.values[into] = scratch->phrase_order.values[take_first ? first++ : second++];
    }
    start = end;
  }
  memcpy(scratch->phrase_order.values, scratch->spare.values, count * sizeof(uint32_t));
}

static narsil_status prepare_token(phrase_scratch *scratch, const narsil_phrase_postings *list, uint32_t token,
                                   work_tally *tally, size_t *row_start) {
  if (scratch->token_starts.values[token] != UINT32_MAX) { return NARSIL_OK; }
  scratch->token_starts.values[token] = (uint32_t)*row_start;
  uint32_t *order = scratch->order.values + *row_start;
  for (uint32_t row = 0; row < list->count; row++) { order[row] = row; }
  if (!list->ordered) {
    narsil_status status = sort_rows(list, order, tally, scratch->spare.values);
    if (status != NARSIL_OK) { return status; }
  }
  *row_start += list->count;
  return NARSIL_OK;
}

narsil_status phrase_prepare(phrase_scratch *scratch, const narsil_phrase_request *request, work_tally *tally,
                             int *missing) {
  narsil_status status = reserve(scratch, request);
  if (status != NARSIL_OK) { return status; }
  size_t row_start = 0;
  *missing = 0;
  for (size_t phrase = 0; phrase < request->phrase_count; phrase++) {
    uint32_t lead = request->starts[phrase];
    for (size_t entry = request->starts[phrase]; entry < request->starts[phrase + 1]; entry++) {
      uint32_t token = request->tokens[entry];
      const narsil_phrase_postings *list = request->postings + token;
      if (list->count == 0) {
        *missing = 1;
        return work_tally_flush(tally);
      }
      status = prepare_token(scratch, list, token, tally, &row_start);
      if (status != NARSIL_OK) { return status; }
      if (list->count < request->postings[request->tokens[lead]].count) { lead = (uint32_t)entry; }
    }
    scratch->leads.values[phrase] = lead;
    scratch->phrase_order.values[phrase] = (uint32_t)phrase;
  }
  for (size_t width = 1; width < request->phrase_count;) {
    merge_phrases(scratch, request, width);
    if (work_tally_flush(tally) != NARSIL_OK) { return tally->status; }
    if (width > request->phrase_count / 2) { break; }
    width *= 2;
  }
  return NARSIL_OK;
}
