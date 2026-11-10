#include "vacuum-strings.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_segments.h"
#include "../../include/narsil_terms.h"
#include "../segment_merge/internal.h"
#include "../terms/table.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

static narsil_status reserve(segment_string_vacuum *plan, const narsil_term_table *table) {
  size_t count = table->header[TERM_COUNT];
  narsil_status status =
      segment_merge_reserve((void **)&plan->entries, count, &plan->entry_capacity, sizeof *plan->entries);
  if (status != NARSIL_OK) { return status; }
  status = segment_merge_reserve((void **)&plan->mapping, count, &plan->mapping_capacity, sizeof *plan->mapping);
  if (status != NARSIL_OK) { return status; }
  return segment_merge_reserve((void **)&plan->units, table->header[TERM_UNITS_USED], &plan->unit_capacity,
                               sizeof *plan->units);
}

narsil_status segment_string_vacuum_prepare(segment_string_vacuum *plan, const narsil_surface_table *table,
                                            const uint32_t *points, const uint32_t *tokens, size_t token_count) {
  plan->source_count = 0;
  plan->count = 0;
  plan->unit_count = 0;
  if (table == NULL) { return NARSIL_OK; }
  const narsil_term_table *strings = &table->strings;
  narsil_status status = reserve(plan, strings);
  if (status != NARSIL_OK) { return status; }
  plan->source_count = strings->header[TERM_COUNT];
  for (uint32_t at = 0; at < plan->source_count; at++) {
    plan->mapping[at] = UINT32_MAX;
    if (table->count[at] == 0) { continue; }
    uint32_t offset = strings->term_offset[at];
    uint32_t length = strings->term_length[at];
    if (offset > strings->header[TERM_UNITS_USED] || length > strings->header[TERM_UNITS_USED] - offset ||
        length > strings->header[TERM_UNITS_USED] - plan->unit_count || table->token[at] >= token_count ||
        tokens[table->token[at]] == UINT32_MAX) {
      return NARSIL_INVALID_ARGUMENT;
    }
    const uint16_t *text = length == 0 ? NULL : strings->units + offset;
    if (term_table_find(strings, text, length) != at) { return NARSIL_INVALID_ARGUMENT; }
    plan->entries[plan->count] = (segment_vacuum_string){(uint32_t)plan->unit_count, length, tokens[table->token[at]],
                                                         table->count[at], points == NULL ? 0 : points[at]};
    plan->mapping[at] = (uint32_t)plan->count++;
    if (length > 0) { memcpy(plan->units + plan->unit_count, text, length * sizeof *text); }
    plan->unit_count += length;
  }
  if (plan->count != strings->header[TERM_LIVE_COUNT] || plan->count >= strings->slot_count) {
    return NARSIL_INVALID_ARGUMENT;
  }
  return NARSIL_OK;
}

void segment_string_vacuum_publish(const segment_string_vacuum *plan, narsil_surface_table *table, uint32_t *points) {
  if (table == NULL) { return; }
  narsil_term_table *strings = &table->strings;
  memset(strings->slots, 0, strings->slot_count * sizeof *strings->slots);
  memset(strings->first_unit_head, 0, strings->head_count * sizeof *strings->first_unit_head);
  if (plan->unit_count > 0) { memcpy(strings->units, plan->units, plan->unit_count * sizeof *strings->units); }
  size_t mask = strings->slot_count - 1;
  for (uint32_t at = 0; at < plan->count; at++) {
    segment_vacuum_string entry = plan->entries[at];
    const uint16_t *text = entry.length == 0 ? NULL : plan->units + entry.offset;
    size_t slot = term_hash(text, entry.length) & mask;
    while (strings->slots[slot] != 0) { slot = (slot + 1) & mask; }
    strings->slots[slot] = (int32_t)at + 1;
    strings->term_offset[at] = entry.offset;
    strings->term_length[at] = entry.length;
    strings->first_unit_next[at] = 0;
    if (entry.length > 0) {
      strings->first_unit_next[at] = strings->first_unit_head[text[0]];
      strings->first_unit_head[text[0]] = at + 1;
    }
    table->token[at] = entry.token;
    table->count[at] = entry.count;
    if (points != NULL) { points[at] = entry.points; }
  }
  for (size_t at = plan->count; at < plan->source_count; at++) { table->count[at] = 0; }
  strings->header[TERM_COUNT] = (uint32_t)plan->count;
  strings->header[TERM_LIVE_COUNT] = (uint32_t)plan->count;
  strings->header[TERM_UNITS_USED] = (uint32_t)plan->unit_count;
  strings->header[TERM_GENERATION]++;
}

void segment_string_vacuum_release(segment_string_vacuum *plan) {
  free(plan->entries);
  free(plan->mapping);
  free(plan->units);
  *plan = (segment_string_vacuum){0};
}

size_t segment_string_vacuum_bytes(const segment_string_vacuum *plan) {
  return (plan->entry_capacity * sizeof *plan->entries) + (plan->mapping_capacity * sizeof *plan->mapping) +
         (plan->unit_capacity * sizeof *plan->units);
}
