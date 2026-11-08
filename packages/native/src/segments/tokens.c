#include "tokens.h"

#include "../../include/narsil_analysis.h"
#include "../../include/narsil_core.h"
#include "../../include/narsil_segments.h"
#include "../analysis/text.h"
#include "strings.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

enum { TOKEN_PLAN_GROWTH = 2, MIN_TOKEN_PLAN = 16, TOKEN_REGIONS = 2, RUN_POINTS = 3 };

static narsil_status reserve_tokens(segment_token_plan *plan, size_t capacity) {
  if (capacity <= plan->capacity) { return NARSIL_OK; }
  if (capacity > SIZE_MAX / (TOKEN_REGIONS * sizeof(segment_token_ref))) { return NARSIL_OUT_OF_MEMORY; }
  size_t held = plan->capacity == 0 ? MIN_TOKEN_PLAN : plan->capacity;
  while (held < capacity) {
    if (held > SIZE_MAX / TOKEN_PLAN_GROWTH) {
      held = capacity;
      break;
    }
    held *= TOKEN_PLAN_GROWTH;
  }
  if (held > SIZE_MAX / (TOKEN_REGIONS * sizeof(segment_token_ref))) { held = capacity; }
  segment_token_ref *tokens = realloc(plan->tokens, held * TOKEN_REGIONS * sizeof *tokens);
  if (tokens == NULL) { return NARSIL_OUT_OF_MEMORY; }
  plan->tokens = tokens;
  plan->capacity = held;
  return NARSIL_OK;
}

static narsil_status prepare_count(segment_strings *strings, const narsil_surface_table *table, segment_string value,
                                   int removing) {
  segment_string *entry = NULL;
  narsil_status status =
      removing ? segment_string_prepare_existing(strings, &table->strings, value.text, value.length, &entry)
               : segment_string_prepare(strings, &table->strings, value.text, value.length, &entry);
  if (status != NARSIL_OK || entry == NULL) { return status; }
  if (entry->count == 0) {
    entry->token = entry->added ? value.token : table->token[entry->ordinal];
    entry->points = value.points;
  }
  uint32_t current = removing || entry->added ? 0 : table->count[entry->ordinal];
  return segment_string_add_count(entry, current, 1);
}

static const uint16_t *text_at(const narsil_tokens *tokens, uint32_t offset) {
  return offset == 0 ? tokens->units : tokens->units + offset;
}

static uint32_t point_count(const uint16_t *text, size_t length) {
  uint32_t count = 0;
  size_t position = 0;
  while (position < length) {
    (void)narsil_decode_next(text, length, &position);
    count++;
  }
  return count;
}

static narsil_status prepare_token(segment_token_plan *plan, const narsil_growing_segment *segment,
                                   const narsil_field_tokens *field, const narsil_token *token, int removing) {
  const uint16_t *text = text_at(&field->tokens, token->term_offset);
  segment_string *term = NULL;
  narsil_status status =
      removing ? segment_string_prepare_existing(&plan->terms, &segment->terms, text, token->term_length, &term)
               : segment_string_prepare(&plan->terms, &segment->terms, text, token->term_length, &term);
  if (status != NARSIL_OK || term == NULL) { return status; }
  const uint16_t *spelling = text;
  size_t length = token->term_length;
  if (token->surface_offset != NARSIL_NO_SURFACE && token->surface_length > 0) {
    spelling = text_at(&field->tokens, token->surface_offset);
    length = token->surface_length;
    if (!narsil_units_equal(text, token->term_length, spelling, length)) {
      if (segment->surfaces == NULL) {
        if (!removing) { return NARSIL_NEEDS_ROOM; }
      } else {
        status = prepare_count(&plan->surfaces, segment->surfaces,
                               (segment_string){.text = spelling, .length = length, .token = term->ordinal}, removing);
        if (status != NARSIL_OK) { return status; }
      }
    }
  }
  if (segment->partial_fields[field->field] != 0) {
    uint32_t points = point_count(spelling, length);
    if (points > RUN_POINTS) {
      status = prepare_count(
          &plan->spellings, &segment->spellings->entries,
          (segment_string){.text = spelling, .length = length, .token = term->ordinal, .points = points}, removing);
      if (status != NARSIL_OK) { return status; }
    }
  }
  plan->tokens[plan->count++] =
      (segment_token_ref){(uint32_t)(term - plan->terms.entries), token->position, field->field};
  return NARSIL_OK;
}

static int order_tokens(const segment_token_ref *first, const segment_token_ref *second) {
  if (first->term != second->term) { return first->term < second->term ? -1 : 1; }
  if (first->field != second->field) { return first->field < second->field ? -1 : 1; }
  if (first->position != second->position) { return first->position < second->position ? -1 : 1; }
  return 0;
}

static int compare_tokens(const void *left, const void *right) { return order_tokens(left, right); }

static void sort_tokens(segment_token_plan *plan) {
  if (plan->count < 2) { return; }
  if (plan->count > UINT32_MAX) {
    qsort(plan->tokens, plan->count, sizeof *plan->tokens, compare_tokens);
    return;
  }
  uint32_t *starts = plan->terms.placements;
  memset(starts, 0, plan->terms.count * sizeof *starts);
  for (size_t at = 0; at < plan->count; at++) { starts[plan->tokens[at].term]++; }
  uint32_t end = 0;
  for (size_t term = 0; term < plan->terms.count; term++) {
    uint32_t count = starts[term];
    starts[term] = end;
    end += count;
  }
  segment_token_ref *ordered = plan->tokens + plan->capacity;
  for (size_t at = 0; at < plan->count; at++) {
    segment_token_ref token = plan->tokens[at];
    ordered[starts[token.term]++] = token;
  }
  memcpy(plan->tokens, ordered, plan->count * sizeof *ordered);
  for (size_t at = 1; at < plan->count; at++) {
    if (order_tokens(plan->tokens + at - 1, plan->tokens + at) > 0) {
      qsort(plan->tokens, plan->count, sizeof *plan->tokens, compare_tokens);
      break;
    }
  }
}

static narsil_status collect_tokens(segment_token_plan *plan, size_t token_count,
                                    const narsil_index_terms_request *request, int removing) {
  narsil_status status = reserve_tokens(plan, token_count);
  if (status != NARSIL_OK) { return status; }
  segment_strings *tables[] = {&plan->terms, &plan->surfaces, &plan->spellings};
  for (size_t index = 0; index < sizeof tables / sizeof tables[0]; index++) { segment_strings_reset(tables[index]); }
  plan->count = 0;
  for (size_t index = 0; index < request->field_count; index++) {
    const narsil_field_tokens *field = request->fields + index;
    for (size_t position = 0; position < field->tokens.token_count; position++) {
      status = prepare_token(plan, request->segment, field, field->tokens.tokens + position, removing);
      if (status != NARSIL_OK) { return status; }
    }
  }
  return NARSIL_OK;
}

narsil_status segment_tokens_for_removal(segment_token_plan *plan, const narsil_index_terms_request *request,
                                         size_t token_count) {
  return collect_tokens(plan, token_count, request, 1);
}

narsil_status segment_tokens_prepare(segment_token_plan *plan, const narsil_index_terms_request *request,
                                     size_t token_count) {
  narsil_status status = collect_tokens(plan, token_count, request, 0);
  if (status != NARSIL_OK) { return status; }
  status = segment_strings_check(&plan->terms, &request->segment->terms);
  if (status != NARSIL_OK) { return status; }
  if (request->segment->surfaces != NULL) {
    status = segment_strings_check(&plan->surfaces, &request->segment->surfaces->strings);
    if (status != NARSIL_OK) { return status; }
  }
  if (request->segment->spellings != NULL) {
    status = segment_strings_check(&plan->spellings, &request->segment->spellings->entries.strings);
    if (status != NARSIL_OK) { return status; }
  }
  sort_tokens(plan);
  return NARSIL_OK;
}

void segment_tokens_release(segment_token_plan *plan) {
  segment_strings_release(&plan->terms);
  segment_strings_release(&plan->surfaces);
  segment_strings_release(&plan->spellings);
  free(plan->tokens);
  memset(plan, 0, sizeof *plan);
}

size_t segment_tokens_bytes(const segment_token_plan *plan) {
  return segment_strings_bytes(&plan->terms) + segment_strings_bytes(&plan->surfaces) +
         segment_strings_bytes(&plan->spellings) + (plan->capacity * TOKEN_REGIONS * sizeof *plan->tokens);
}
