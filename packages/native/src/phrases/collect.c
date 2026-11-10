#include "internal.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_phrases.h"
#include "../work/tally.h"
#include "scratch.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

typedef struct {
  phrase_scratch *scratch;
  const narsil_phrase_request *request;
  const narsil_phrase_output *output;
  work_tally *tally;
  uint32_t phrase;
  const uint32_t *allowed;
} phrase_match;

static int has(const uint32_t *bitmap, uint32_t ordinal) {
  return (bitmap[ordinal / PHRASE_WORD_BITS] & (UINT32_C(1) << (ordinal % PHRASE_WORD_BITS))) != 0;
}

typedef struct {
  uint32_t document;
  uint16_t field;
} phrase_document_field;

static size_t row_for(const phrase_match *match, uint32_t token, phrase_document_field target) {
  const narsil_phrase_postings *list = match->request->postings + token;
  const uint32_t *order = match->scratch->order.values + match->scratch->token_starts.values[token];
  size_t low = 0;
  size_t high = list->count;
  while (low < high) {
    size_t middle = low + ((high - low) / 2);
    if (list->documents[order[middle]] < target.document) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  for (size_t at = low; at < list->count && list->documents[order[at]] == target.document; at++) {
    uint32_t row = order[at];
    if (list->fields[row] == target.field && phrase_row_valid(match->request, list, row)) { return row; }
  }
  return SIZE_MAX;
}

static int position_rows(phrase_match *match, uint32_t lead_row) {
  const narsil_phrase_request *request = match->request;
  phrase_scratch *scratch = match->scratch;
  uint32_t lead_token = request->tokens[scratch->leads.values[match->phrase]];
  const narsil_phrase_postings *lead = request->postings + lead_token;
  for (size_t entry = request->starts[match->phrase]; entry < request->starts[(size_t)match->phrase + 1]; entry++) {
    uint32_t token = request->tokens[entry];
    phrase_document_field target = {lead->documents[lead_row], lead->fields[lead_row]};
    size_t row = token == lead_token ? lead_row : row_for(match, token, target);
    if (row == SIZE_MAX) { return 0; }
    const narsil_phrase_postings *list = request->postings + token;
    scratch->position_rows.values[entry] = (uint32_t)row;
    scratch->cursors.values[entry] = list->position_starts[row];
    scratch->ends.values[entry] = list->position_starts[row] + list->position_counts[row];
  }
  return 1;
}

static int holds_start(phrase_match *match, uint64_t anchor) {
  const narsil_phrase_request *request = match->request;
  for (size_t entry = request->starts[match->phrase]; entry < request->starts[(size_t)match->phrase + 1]; entry++) {
    const narsil_phrase_postings *list = request->postings + request->tokens[entry];
    uint64_t wanted = anchor + request->offsets[entry];
    uint32_t cursor = match->scratch->cursors.values[entry];
    uint32_t end = match->scratch->ends.values[entry];
    while (cursor < end && list->positions[cursor] < wanted) {
      cursor++;
      if (work_tally_add(match->tally, 1) != NARSIL_OK) { return -1; }
    }
    match->scratch->cursors.values[entry] = cursor;
    if (work_tally_add(match->tally, 1) != NARSIL_OK || cursor == end) { return -1; }
    if (list->positions[cursor] != wanted) { return 0; }
  }
  return 1;
}

static uint32_t count_starts(phrase_match *match, uint32_t lead_row) {
  const narsil_phrase_request *request = match->request;
  uint32_t lead_entry = match->scratch->leads.values[match->phrase];
  const narsil_phrase_postings *lead = request->postings + request->tokens[lead_entry];
  uint32_t lead_offset = request->offsets[lead_entry];
  size_t start = lead->position_starts[lead_row];
  size_t end = start + lead->position_counts[lead_row];
  uint32_t count = 0;
  for (size_t at = start; at < end; at++) {
    uint32_t position = lead->positions[at];
    if (position < lead_offset) { continue; }
    int matched = holds_start(match, (uint64_t)position - lead_offset);
    if (matched < 0) { break; }
    if (matched > 0) { count++; }
  }
  return count;
}

static narsil_status collect_rows(phrase_match *match, int *matched) {
  const narsil_phrase_request *request = match->request;
  phrase_scratch *scratch = match->scratch;
  uint32_t token = request->tokens[scratch->leads.values[match->phrase]];
  const narsil_phrase_postings *lead = request->postings + token;
  const uint32_t *order = scratch->order.values + scratch->token_starts.values[token];
  *matched = 0;
  memset(scratch->next.values, 0, phrase_bitmap_words(request->ordinal_count) * sizeof(uint32_t));
  for (size_t at = 0; at < lead->count; at++) {
    if (work_tally_add(match->tally, 1) != NARSIL_OK) { return match->tally->status; }
    uint32_t row = order[at];
    if (!phrase_row_valid(request, lead, row)) { continue; }
    uint32_t document = lead->documents[row];
    uint16_t field = lead->fields[row];
    if (request->searchable[field] == 0 || has(request->removed, document) ||
        (match->allowed != NULL && !has(match->allowed, document)) || !position_rows(match, row)) {
      continue;
    }
    uint32_t frequency = count_starts(match, row);
    if (match->tally->status != NARSIL_OK) { return match->tally->status; }
    if (frequency == 0) { continue; }
    scratch->next.values[document / PHRASE_WORD_BITS] |= UINT32_C(1) << (document % PHRASE_WORD_BITS);
    *matched = 1;
    if (request->collect) {
      size_t into = (size_t)scratch->row_starts.values[match->phrase] + scratch->row_counts.values[match->phrase]++;
      match->output->documents[into] = document;
      match->output->fields[into] = field;
      match->output->frequencies[into] = frequency;
    }
  }
  return NARSIL_OK;
}

narsil_status phrase_collect(phrase_scratch *scratch, const narsil_phrase_request *request,
                             const narsil_phrase_output *output, work_tally *tally) {
  size_t start = 0;
  for (size_t phrase = 0; phrase < request->phrase_count; phrase++) {
    scratch->row_starts.values[phrase] = (uint32_t)start;
    if (request->collect) { start += request->postings[request->tokens[scratch->leads.values[phrase]]].count; }
  }
  const uint32_t *allowed = request->filter;
  for (size_t at = 0; at < request->phrase_count; at++) {
    phrase_match match = {scratch, request, output, tally, scratch->phrase_order.values[at], allowed};
    int matched = 0;
    narsil_status status = collect_rows(&match, &matched);
    if (status != NARSIL_OK) { return status; }
    memcpy(scratch->matched.values, scratch->next.values,
           phrase_bitmap_words(request->ordinal_count) * sizeof(uint32_t));
    allowed = scratch->matched.values;
    if (!matched) { break; }
  }
  if (request->phrase_count == 0 && request->filter != NULL) {
    memcpy(scratch->matched.values, request->filter, phrase_bitmap_words(request->ordinal_count) * sizeof(uint32_t));
  }
  return work_tally_flush(tally);
}
