#include "vacuum.h"

#include "../../include/narsil_segments.h"
#include "../../include/narsil_terms.h"
#include "../terms/table.h"
#include "pools.h"
#include "vacuum-runs.h"
#include "vacuum-strings.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

void segment_vacuum_release(segment_vacuum *plan) {
  free(plan->mapping);
  free(plan->terms);
  free(plan->slices);
  free(plan->rows);
  free(plan->units);
  free(plan->positions);
  segment_string_vacuum_release(&plan->surfaces);
  segment_string_vacuum_release(&plan->spellings);
  segment_run_vacuum_release(&plan->runs);
  *plan = (segment_vacuum){0};
}

size_t segment_vacuum_bytes(const segment_vacuum *plan) {
  return (plan->mapping_capacity * sizeof *plan->mapping) + (plan->term_capacity * sizeof *plan->terms) +
         (plan->slice_capacity * sizeof *plan->slices) + (plan->row_capacity * sizeof *plan->rows) +
         (plan->unit_capacity * sizeof *plan->units) + (plan->position_capacity * sizeof *plan->positions) +
         segment_string_vacuum_bytes(&plan->surfaces) + segment_string_vacuum_bytes(&plan->spellings) +
         segment_run_vacuum_bytes(&plan->runs);
}

static void publish_term(const segment_vacuum *plan, narsil_growing_segment *segment, uint32_t ordinal) {
  const segment_vacuum_term *term = plan->terms + ordinal;
  narsil_term_columns *columns = &segment->columns;
  narsil_term_table *table = &segment->terms;
  const uint16_t *text = term->text_length == 0 ? NULL : plan->units + term->text_start;
  size_t mask = table->slot_count - 1;
  size_t slot = term_hash(text, term->text_length) & mask;
  while (table->slots[slot] != 0) { slot = (slot + 1) & mask; }
  table->slots[slot] = (int32_t)ordinal + 1;
  table->term_offset[ordinal] = term->text_start;
  table->term_length[ordinal] = term->text_length;
  if (term->text_length > 0) {
    table->first_unit_next[ordinal] = table->first_unit_head[text[0]];
    table->first_unit_head[text[0]] = ordinal + 1;
  } else {
    table->first_unit_next[ordinal] = 0;
  }
  columns->slice_start[ordinal] = term->row_start;
  columns->slice_class[ordinal] = term->slice_class;
  columns->lengths[ordinal] = term->length;
  columns->doc_frequency[ordinal] = term->frequency;
  columns->dead_documents[ordinal] = 0;
  columns->total_term_frequency[ordinal] = term->occurrences;
  columns->surface_occurrences[ordinal] = term->surfaces;
  columns->revision[ordinal] = term->revision;
  columns->flags[ordinal] = term->flags;
  for (size_t at = term->row_start; at < (size_t)term->row_start + term->length; at++) {
    segment_vacuum_row row = plan->rows[at];
    segment->postings.doc_ids[at] = row.document;
    segment->postings.frequencies[at] = row.frequency;
    segment->postings.field_indices[at] = row.field;
    if (segment->postings.position_starts != NULL) { segment->postings.position_starts[at] = row.positions; }
  }
}

void segment_vacuum_publish(const segment_vacuum *plan, narsil_growing_segment *segment) {
  narsil_term_table *table = &segment->terms;
  memset(table->slots, 0, table->slot_count * sizeof *table->slots);
  memset(table->first_unit_head, 0, table->head_count * sizeof *table->first_unit_head);
  if (plan->unit_count > 0) { memcpy(table->units, plan->units, plan->unit_count * sizeof *table->units); }
  for (uint32_t at = 0; at < plan->term_count; at++) { publish_term(plan, segment, at); }
  for (size_t at = plan->term_count; at < plan->source_count; at++) { segment->columns.flags[at] = 0; }
  table->header[TERM_COUNT] = (uint32_t)plan->term_count;
  table->header[TERM_LIVE_COUNT] = (uint32_t)plan->term_count;
  table->header[TERM_UNITS_USED] = (uint32_t)plan->unit_count;
  table->header[TERM_GENERATION]++;
  segment->postings.allocator.allocation[SEGMENT_POOL_END] = (uint32_t)plan->row_count;
  segment->postings.allocator.allocation[SEGMENT_POOL_FREE] = 0;
  for (size_t at = 0; at < segment->postings.allocator.class_count; at++) {
    segment->postings.allocator.free_heads[at] = UINT32_MAX;
  }
  if (segment->positions != NULL) {
    segment->positions->values[0] = 0;
    if (plan->position_count > 1) {
      memcpy(segment->positions->values + 1, plan->positions + 1, (plan->position_count - 1) * sizeof *plan->positions);
    }
    segment->positions->allocation[SEGMENT_POOL_END] = (uint32_t)plan->position_count;
    segment->positions->allocation[SEGMENT_POOL_FREE] = 0;
  }
  segment_string_vacuum_publish(&plan->surfaces, segment->surfaces, NULL);
  if (segment->spellings != NULL) {
    segment_string_vacuum_publish(&plan->spellings, &segment->spellings->entries, segment->spellings->code_points);
    segment_run_vacuum_publish(&plan->runs, &segment->spellings->runs);
  }
}
