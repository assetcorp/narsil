#include "frozen.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_frozen_segments.h"
#include "../../include/narsil_segments.h"
#include "../regions.h"
#include "regions.h"

#include <stddef.h>
#include <stdint.h>

enum { FROZEN_WORD_BITS = 32 };

static int input(const segment_regions *regions, const void *pointer, size_t count, size_t width) {
  return (count == 0 || (uintptr_t)pointer % width == 0) && segment_region_input(regions, pointer, count, width);
}

static int strings(const segment_regions *regions, const narsil_frozen_strings *table, size_t stride) {
  if (table == NULL || (uintptr_t)table % _Alignof(narsil_frozen_strings) != 0 || table->count > UINT32_MAX ||
      table->text_bytes > UINT32_MAX || table->count > (SIZE_MAX - 1) / stride) {
    return 0;
  }
  return segment_region_input(regions, table, 1, sizeof *table) &&
         input(regions, table->text, table->text_bytes, sizeof *table->text) &&
         input(regions, table->offsets, (table->count * stride) + 1, sizeof *table->offsets) &&
         input(regions, table->counts, table->count, sizeof *table->counts);
}

static int frozen_pending_regions(segment_regions *regions, const narsil_frozen_segment_state *state) {
  if (state->pending_header == NULL || (uintptr_t)state->pending_header % _Alignof(uint32_t) != 0 ||
      (uintptr_t)state->pending_documents % _Alignof(uint32_t) != 0 ||
      (uintptr_t)state->pending_tokens % _Alignof(uint32_t) != 0 ||
      (uintptr_t)state->pending_units % _Alignof(uint16_t) != 0 || state->pending_document_capacity > UINT32_MAX ||
      state->pending_token_capacity > UINT32_MAX ||
      state->pending_token_capacity > SIZE_MAX / NARSIL_PENDING_TOKEN_WORDS ||
      state->pending_unit_capacity > UINT32_MAX ||
      !segment_region_write(regions, state->pending_header, NARSIL_PENDING_HEADER_WORDS,
                            sizeof *state->pending_header) ||
      !segment_region_write(regions, state->pending_documents, state->pending_document_capacity,
                            sizeof *state->pending_documents) ||
      !segment_region_write(regions, state->pending_tokens, state->pending_token_capacity * NARSIL_PENDING_TOKEN_WORDS,
                            sizeof *state->pending_tokens) ||
      !segment_region_write(regions, state->pending_units, state->pending_unit_capacity,
                            sizeof *state->pending_units)) {
    return 0;
  }
  return state->pending_header[NARSIL_PENDING_DOCUMENTS] <= state->pending_document_capacity &&
         state->pending_header[NARSIL_PENDING_TOKENS] <= state->pending_token_capacity &&
         state->pending_header[NARSIL_PENDING_UNITS] <= state->pending_unit_capacity;
}

static int state_regions(segment_regions *regions, const narsil_frozen_segment *segment,
                         const narsil_frozen_segment_state *state) {
  size_t words = segment->document_count == 0 ? 1 : (((size_t)segment->document_count - 1) / FROZEN_WORD_BITS) + 1;
  if (!segment_region_write(regions, state->tombstones, words, sizeof *state->tombstones) ||
      !segment_region_write(regions, state->tombstone_count, 1, sizeof *state->tombstone_count) ||
      !segment_region_write(regions, state->removed_documents, segment->terms.count,
                            sizeof *state->removed_documents) ||
      !segment_region_write(regions, state->removed_occurrences, segment->terms.count,
                            sizeof *state->removed_occurrences) ||
      !segment_region_write(regions, state->removed_surfaces, segment->surfaces == NULL ? 0 : segment->surfaces->count,
                            sizeof *state->removed_surfaces) ||
      !segment_region_write(regions, state->removed_spellings,
                            segment->spellings == NULL ? 0 : segment->spellings->count,
                            sizeof *state->removed_spellings) ||
      !frozen_pending_regions(regions, state)) {
    return 0;
  }
  for (size_t at = 0; at < regions->write_count; at++) {
    for (size_t prior = 0; prior < at; prior++) {
      if (overlaps(regions->writes[at], regions->writes[prior])) { return 0; }
    }
  }
  return 1;
}

static int source_regions(const segment_regions *regions, const narsil_frozen_segment *segment) {
  if (segment->terms.count == SIZE_MAX || segment->posting_count > UINT32_MAX ||
      !segment_region_input(regions, segment, 1, sizeof *segment) || !strings(regions, &segment->terms, 1) ||
      !input(regions, segment->payload_slots, segment->terms.count, sizeof *segment->payload_slots) ||
      !input(regions, segment->posting_offsets, segment->terms.count + 1, sizeof *segment->posting_offsets) ||
      !input(regions, segment->posting_documents, segment->posting_count, sizeof *segment->posting_documents) ||
      !input(regions, segment->posting_frequencies, segment->posting_count, sizeof *segment->posting_frequencies) ||
      !input(regions, segment->posting_fields, segment->posting_count, sizeof *segment->posting_fields) ||
      !input(regions, segment->partial_fields, segment->field_count, sizeof *segment->partial_fields) ||
      (segment->surfaces != NULL && !strings(regions, segment->surfaces, 2)) ||
      (segment->spellings != NULL &&
       (!strings(regions, segment->spellings, 1) ||
        !input(regions, segment->spelling_tokens, segment->spellings->count, sizeof *segment->spelling_tokens)))) {
    return 0;
  }
  const narsil_frozen_removal_index *index = segment->removal_index;
  size_t starts = (size_t)segment->document_count + 1;
  if (index != NULL && ((uintptr_t)index % _Alignof(narsil_frozen_removal_index) != 0 || starts == 0 ||
                        !segment_region_input(regions, index, 1, sizeof *index) ||
                        !input(regions, index->starts, starts, sizeof *index->starts) ||
                        !input(regions, index->rows, segment->posting_count, sizeof *index->rows) ||
                        !input(regions, index->term_of_slot, segment->terms.count, sizeof *index->term_of_slot))) {
    return 0;
  }
  for (size_t field = 0; field < segment->field_count; field++) {
    if (segment->partial_fields[field] > 1) { return 0; }
  }
  return 1;
}

static int aligned_source(const narsil_frozen_segment *segment, const narsil_frozen_segment_state *state) {
  return segment != NULL && (uintptr_t)segment % _Alignof(narsil_frozen_segment) == 0 && state != NULL &&
         (uintptr_t)state % _Alignof(narsil_frozen_segment_state) == 0 &&
         segment->field_count <= (uint32_t)UINT16_MAX + 1 &&
         (segment->surfaces == NULL || (uintptr_t)segment->surfaces % _Alignof(narsil_frozen_strings) == 0) &&
         (segment->spellings == NULL || (uintptr_t)segment->spellings % _Alignof(narsil_frozen_strings) == 0);
}

static int settled(const narsil_frozen_segment_state *state) {
  return state->pending_header[NARSIL_PENDING_DOCUMENTS] == 0 && state->pending_header[NARSIL_PENDING_TOKENS] == 0 &&
         state->pending_header[NARSIL_PENDING_UNITS] == 0;
}

int frozen_read_regions(const narsil_frozen_segment *segment, const narsil_frozen_segment_state *state,
                        const segment_regions *outputs) {
  if (!aligned_source(segment, state)) { return 0; }
  segment_regions held = {0};
  if (!state_regions(&held, segment, state) || !source_regions(&held, segment) || !source_regions(outputs, segment) ||
      !segment_region_input(outputs, state, 1, sizeof *state) ||
      !segment_region_input(&held, state, 1, sizeof *state) || *state->tombstone_count > segment->document_count ||
      !settled(state)) {
    return 0;
  }
  for (size_t at = 0; at < held.write_count; at++) {
    for (size_t output = 0; output < outputs->write_count; output++) {
      if (overlaps(held.writes[at], outputs->writes[output])) { return 0; }
    }
  }
  return 1;
}

narsil_status frozen_settle_regions(const narsil_frozen_segment *segment, const narsil_frozen_segment_state *state) {
  if (!aligned_source(segment, state)) { return NARSIL_INVALID_ARGUMENT; }
  segment_regions regions = {0};
  if (!state_regions(&regions, segment, state) || !source_regions(&regions, segment) ||
      !segment_region_input(&regions, state, 1, sizeof *state) || *state->tombstone_count > segment->document_count) {
    return NARSIL_INVALID_ARGUMENT;
  }
  return NARSIL_OK;
}

static int paged_input(const segment_regions *regions, const narsil_frozen_paged_removals *paged) {
  return paged == NULL || ((uintptr_t)paged % _Alignof(narsil_frozen_paged_removals) == 0 &&
                           segment_region_input(regions, paged, 1, sizeof *paged) && paged->offsets != NULL &&
                           paged->values != NULL && paged->fault != NULL);
}

static int removal_shape(const narsil_remove_frozen_request *request) {
  return request != NULL && (uintptr_t)request % _Alignof(narsil_remove_frozen_request) == 0 &&
         aligned_source(request->segment, request->state) && request->field_count <= request->segment->field_count &&
         request->ordinal < request->segment->document_count;
}

static int removal_inputs(const segment_regions *regions, const narsil_remove_frozen_request *request) {
  const narsil_frozen_segment *segment = request->segment;
  if (!source_regions(regions, segment) || !paged_input(regions, request->paged) ||
      !segment_region_input(regions, request, 1, sizeof *request) ||
      !segment_region_input(regions, request->state, 1, sizeof *request->state) ||
      (uintptr_t)request->fields % _Alignof(narsil_field_tokens) != 0 ||
      !segment_region_input(regions, request->fields, request->field_count, sizeof *request->fields) ||
      *request->state->tombstone_count > segment->document_count) {
    return 0;
  }
  for (size_t at = 0; at < request->field_count; at++) {
    const narsil_field_tokens *field = request->fields + at;
    if (field->field >= segment->field_count || (at > 0 && field->field <= request->fields[at - 1].field) ||
        !segment_valid_tokens(regions, &field->tokens)) {
      return 0;
    }
  }
  return 1;
}

narsil_status frozen_removal_regions(const narsil_remove_frozen_request *request) {
  if (!removal_shape(request)) { return NARSIL_INVALID_ARGUMENT; }
  segment_regions regions = {0};
  if (!state_regions(&regions, request->segment, request->state) || !removal_inputs(&regions, request)) {
    return NARSIL_INVALID_ARGUMENT;
  }
  return NARSIL_OK;
}

static int record_writes(segment_regions *regions, const narsil_remove_frozen_request *request,
                         const narsil_frozen_removal_output *output, size_t *count) {
  const narsil_frozen_segment *segment = request->segment;
  const narsil_frozen_segment_state *state = request->state;
  size_t words = segment->document_count == 0 ? 1 : (((size_t)segment->document_count - 1) / FROZEN_WORD_BITS) + 1;
  if (!segment_region_write(regions, state->tombstones, words, sizeof *state->tombstones) ||
      !segment_region_write(regions, state->tombstone_count, 1, sizeof *state->tombstone_count) ||
      !frozen_pending_regions(regions, state) ||
      !segment_region_write(regions, output->entries, output->entry_capacity * 2, sizeof *output->entries) ||
      !segment_region_write(regions, output->values, output->value_capacity, sizeof *output->values) ||
      !segment_region_write(regions, count, 1, sizeof *count)) {
    return 0;
  }
  for (size_t at = 0; at < regions->write_count; at++) {
    for (size_t prior = 0; prior < at; prior++) {
      if (overlaps(regions->writes[at], regions->writes[prior])) { return 0; }
    }
  }
  return 1;
}

narsil_status frozen_record_regions(const narsil_remove_frozen_request *request,
                                    const narsil_frozen_removal_output *output, size_t *count) {
  if (!removal_shape(request) || output == NULL || (uintptr_t)output % _Alignof(narsil_frozen_removal_output) != 0 ||
      output->entry_capacity > SIZE_MAX / 2) {
    return NARSIL_INVALID_ARGUMENT;
  }
  const narsil_frozen_segment *segment = request->segment;
  segment_regions regions = {0};
  if (!record_writes(&regions, request, output, count) ||
      !segment_region_input(&regions, segment, 1, sizeof *segment) ||
      !segment_region_input(&regions, request, 1, sizeof *request) ||
      !segment_region_input(&regions, request->state, 1, sizeof *request->state) ||
      !segment_region_input(&regions, output, 1, sizeof *output) ||
      (uintptr_t)request->fields % _Alignof(narsil_field_tokens) != 0 ||
      !segment_region_input(&regions, request->fields, request->field_count, sizeof *request->fields) ||
      *request->state->tombstone_count > segment->document_count) {
    return NARSIL_INVALID_ARGUMENT;
  }
  for (size_t at = 0; at < request->field_count; at++) {
    const narsil_field_tokens *field = request->fields + at;
    if (field->field >= segment->field_count || (at > 0 && field->field <= request->fields[at - 1].field) ||
        !segment_valid_tokens(&regions, &field->tokens)) {
      return NARSIL_INVALID_ARGUMENT;
    }
  }
  return NARSIL_OK;
}

narsil_status frozen_prepared_removal_regions(const narsil_remove_frozen_request *request,
                                              const narsil_frozen_removal_output *output, size_t *count) {
  if (!removal_shape(request) || output == NULL || (uintptr_t)output % _Alignof(narsil_frozen_removal_output) != 0 ||
      output->entry_capacity > SIZE_MAX / 2) {
    return NARSIL_INVALID_ARGUMENT;
  }
  segment_regions regions = {0};
  if (!state_regions(&regions, request->segment, request->state)) { return NARSIL_INVALID_ARGUMENT; }
  size_t state_writes = regions.write_count;
  if (!segment_region_write(&regions, output->entries, output->entry_capacity * 2, sizeof *output->entries) ||
      !segment_region_write(&regions, output->values, output->value_capacity, sizeof *output->values) ||
      !segment_region_write(&regions, count, 1, sizeof *count)) {
    return NARSIL_INVALID_ARGUMENT;
  }
  for (size_t at = state_writes; at < regions.write_count; at++) {
    for (size_t prior = 0; prior < at; prior++) {
      if (overlaps(regions.writes[at], regions.writes[prior])) { return NARSIL_INVALID_ARGUMENT; }
    }
  }
  if (!segment_region_input(&regions, output, 1, sizeof *output) || !removal_inputs(&regions, request)) {
    return NARSIL_INVALID_ARGUMENT;
  }
  return NARSIL_OK;
}
