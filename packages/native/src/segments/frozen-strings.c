#include "frozen.h"

#include "../../include/narsil_analysis.h"
#include "../../include/narsil_core.h"
#include "../../include/narsil_frozen_segments.h"
#include "../../include/narsil_segments.h"
#include "../analysis/text.h"
#include "../terms/dictionary.h"
#include "strings.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

static int cursor_at(const narsil_frozen_strings *table, size_t offset, term_cursor *cursor) {
  uint32_t start = table->offsets[offset];
  uint32_t end = table->offsets[offset + 1];
  if (start > end || end > table->text_bytes) { return 0; }
  *cursor = (term_cursor){NULL, table->text, start, end};
  return 1;
}

static int compare_text(term_cursor cursor, const uint16_t *text, size_t length, int *valid) {
  term_cursor query = {text, NULL, 0, length};
  int order = 0;
  size_t units = 0;
  for (;;) {
    uint32_t first = 0;
    uint32_t second = 0;
    int has_first = term_next(&cursor, &first);
    int has_second = term_next(&query, &second);
    if (has_first < 0 || has_second < 0) {
      *valid = 0;
      return 0;
    }
    if (has_first == 0) { return order == 0 ? -has_second : order; }
    units += first >= NARSIL_SUPPLEMENTARY_FIRST ? 2 : 1;
    if (units > NARSIL_MAX_ANALYSED_UNITS) {
      *valid = 0;
      return 0;
    }
    if (order == 0) {
      if (has_second == 0) {
        order = 1;
      } else if (first != second) {
        order = first < second ? -1 : 1;
      }
    }
  }
}

typedef struct {
  const uint32_t *tokens;
  uint32_t token;
  size_t stride;
} entry_key;

static int64_t find_entry(const narsil_frozen_strings *table, entry_key key, const uint16_t *text, size_t length) {
  const uint32_t *tokens = key.tokens;
  uint32_t token = key.token;
  size_t low = 0;
  size_t high = table->count;
  while (low < high) {
    size_t middle = low + ((high - low) / 2);
    term_cursor cursor;
    int valid = 1;
    int order = 0;
    if (!cursor_at(table, middle * key.stride, &cursor)) { break; }
    order = compare_text(cursor, text, length, &valid);
    if (!valid) { break; }
    if (order == 0 && tokens != NULL && tokens[middle] != token) { order = tokens[middle] < token ? -1 : 1; }
    if (order == 0) { return (int64_t)middle; }
    if (order < 0) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  if (low == high) { return -1; }
  for (size_t at = 0; at < table->count; at++) {
    term_cursor cursor;
    int valid = 1;
    if ((tokens == NULL || tokens[at] == token) && cursor_at(table, at * key.stride, &cursor) &&
        compare_text(cursor, text, length, &valid) == 0 && valid) {
      return (int64_t)at;
    }
  }
  return -1;
}

static narsil_status collect_token(frozen_removal_plan *plan, const narsil_frozen_segment *segment,
                                   const narsil_field_tokens *field, const narsil_token *token) {
  const uint16_t *term = token->term_offset == 0 ? field->tokens.units : field->tokens.units + token->term_offset;
  const uint16_t *spelling = term;
  size_t length = token->term_length;
  if (token->surface_offset != NARSIL_NO_SURFACE && token->surface_length > 0) {
    spelling = field->tokens.units + token->surface_offset;
    length = token->surface_length;
    if (segment->surfaces != NULL && !narsil_units_equal(term, token->term_length, spelling, length)) {
      segment_string *entry = NULL;
      narsil_status status = segment_string_prepare(&plan->surfaces, NULL, spelling, length, &entry);
      if (status != NARSIL_OK) { return status; }
      if (entry->count < UINT32_MAX) { entry->count++; }
    }
  }
  if (segment->spellings == NULL || segment->partial_fields[field->field] == 0) { return NARSIL_OK; }
  int64_t term_at = find_entry(&segment->terms, (entry_key){NULL, 0, 1}, term, token->term_length);
  if (term_at < 0) { return NARSIL_OK; }
  int64_t entry =
      find_entry(segment->spellings, (entry_key){segment->spelling_tokens, (uint32_t)term_at, 1}, spelling, length);
  return entry < 0 ? NARSIL_OK : frozen_removal_add(plan, FROZEN_SPELLING, (uint32_t)entry, 1);
}

static int surfaces_ascend(const narsil_frozen_strings *table) {
  for (size_t entry = 0; entry < table->count; entry++) {
    uint32_t start = table->offsets[entry * 2];
    uint32_t end = table->offsets[(entry * 2) + 1];
    if (start > end || end > table->text_bytes) { return 0; }
    if (entry == 0) { continue; }
    uint32_t prior_start = table->offsets[(entry - 1) * 2];
    size_t prior_length = table->offsets[((entry - 1) * 2) + 1] - prior_start;
    size_t length = end - start;
    size_t shorter = prior_length < length ? prior_length : length;
    int order = shorter == 0 ? 0 : memcmp(table->text + prior_start, table->text + start, shorter);
    if (order > 0 || (order == 0 && prior_length >= length)) { return 0; }
  }
  return 1;
}

static int table_ascends(frozen_removal_plan *plan, const narsil_frozen_strings *table) {
  for (size_t slot = 0; slot < FROZEN_TABLE_ORDER_SLOTS; slot++) {
    const frozen_table_order *held = plan->orders + slot;
    if (held->offsets == table->offsets && held->text == table->text && held->text_bytes == table->text_bytes &&
        held->count == table->count) {
      return held->ascends;
    }
  }
  frozen_table_order *slot = plan->orders + (plan->next_order % FROZEN_TABLE_ORDER_SLOTS);
  plan->next_order = (plan->next_order + 1) % FROZEN_TABLE_ORDER_SLOTS;
  *slot = (frozen_table_order){table->text, table->offsets, table->text_bytes, table->count, surfaces_ascend(table)};
  return slot->ascends;
}

static narsil_status find_surfaces(frozen_removal_plan *plan, const narsil_frozen_strings *table) {
  for (size_t at = 0; at < plan->surfaces.count; at++) {
    const segment_string *held = plan->surfaces.entries + at;
    int64_t entry = find_entry(table, (entry_key){NULL, 0, 2}, held->text, held->length);
    if (entry < 0) { continue; }
    narsil_status status = frozen_removal_add(plan, FROZEN_SURFACE, (uint32_t)entry, held->count);
    if (status != NARSIL_OK) { return status; }
  }
  return NARSIL_OK;
}

static narsil_status collect_surfaces(frozen_removal_plan *plan, const narsil_frozen_strings *table) {
  if (table == NULL || plan->surfaces.count == 0) { return NARSIL_OK; }
  if (table_ascends(plan, table)) { return find_surfaces(plan, table); }
  for (size_t entry = 0; entry < table->count; entry++) {
    term_cursor cursor;
    if (!cursor_at(table, entry * 2, &cursor)) { continue; }
    plan->text.length = 0;
    uint32_t point = 0;
    int next = 0;
    while ((next = term_next(&cursor, &point)) > 0) {
      if (narsil_text_push_code_point(&plan->text, point) != NARSIL_OK) { return NARSIL_OUT_OF_MEMORY; }
      if (plan->text.length > NARSIL_MAX_ANALYSED_UNITS) {
        next = -1;
        break;
      }
    }
    if (next < 0) { continue; }
    segment_string *held = segment_string_find(&plan->surfaces, plan->text.units, plan->text.length);
    if (held != NULL) {
      narsil_status status = frozen_removal_add(plan, FROZEN_SURFACE, (uint32_t)entry, held->count);
      if (status != NARSIL_OK) { return status; }
    }
  }
  return NARSIL_OK;
}

narsil_status frozen_remove_strings(frozen_removal_plan *plan, const narsil_remove_frozen_request *request) {
  segment_strings_reset(&plan->surfaces);
  const narsil_frozen_segment *segment = request->segment;
  if (segment->surfaces == NULL && segment->spellings == NULL) { return NARSIL_OK; }
  for (size_t at = 0; at < request->field_count; at++) {
    const narsil_field_tokens *field = request->fields + at;
    for (size_t index = 0; index < field->tokens.token_count; index++) {
      narsil_status status = collect_token(plan, segment, field, field->tokens.tokens + index);
      if (status != NARSIL_OK) { return status; }
    }
  }
  return collect_surfaces(plan, segment->surfaces);
}
