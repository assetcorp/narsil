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

static int state_regions(segment_regions *regions, const narsil_remove_frozen_request *request) {
  const narsil_frozen_segment *segment = request->segment;
  narsil_frozen_segment_state *state = request->state;
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
                            sizeof *state->removed_spellings)) {
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
      segment->removal_words % 2 != 0 ||
      !input(regions, segment->removal_terms, segment->removal_words, sizeof *segment->removal_terms) ||
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
  for (size_t at = 0; at < segment->removal_words; at += 2) {
    if (segment->removal_terms[at] >= segment->terms.count ||
        (at > 0 && segment->removal_terms[at] <= segment->removal_terms[at - 2])) {
      return 0;
    }
  }
  return 1;
}

int frozen_read_regions(const narsil_frozen_segment *segment, const narsil_frozen_segment_state *state,
                        const segment_regions *outputs) {
  if (segment == NULL || (uintptr_t)segment % _Alignof(narsil_frozen_segment) != 0 || state == NULL ||
      (uintptr_t)state % _Alignof(narsil_frozen_segment_state) != 0 ||
      segment->field_count > (uint32_t)UINT16_MAX + 1 ||
      (segment->surfaces != NULL && (uintptr_t)segment->surfaces % _Alignof(narsil_frozen_strings) != 0) ||
      (segment->spellings != NULL && (uintptr_t)segment->spellings % _Alignof(narsil_frozen_strings) != 0)) {
    return 0;
  }
  narsil_frozen_segment_state held_state = *state;
  narsil_remove_frozen_request request = {.segment = segment, .state = &held_state};
  segment_regions held = {0};
  if (!state_regions(&held, &request) || !source_regions(&held, segment) || !source_regions(outputs, segment) ||
      !segment_region_input(outputs, state, 1, sizeof *state) ||
      !segment_region_input(&held, state, 1, sizeof *state) || *state->tombstone_count > segment->document_count) {
    return 0;
  }
  for (size_t at = 0; at < held.write_count; at++) {
    for (size_t output = 0; output < outputs->write_count; output++) {
      if (overlaps(held.writes[at], outputs->writes[output])) { return 0; }
    }
  }
  return 1;
}

narsil_status frozen_removal_regions(const narsil_remove_frozen_request *request) {
  if (request == NULL || (uintptr_t)request % _Alignof(narsil_remove_frozen_request) != 0 || request->segment == NULL ||
      (uintptr_t)request->segment % _Alignof(narsil_frozen_segment) != 0 || request->state == NULL ||
      (uintptr_t)request->state % _Alignof(narsil_frozen_segment_state) != 0) {
    return NARSIL_INVALID_ARGUMENT;
  }
  const narsil_frozen_segment *segment = request->segment;
  if (segment->field_count > (uint32_t)UINT16_MAX + 1 || request->field_count > segment->field_count ||
      request->ordinal >= segment->document_count ||
      (segment->surfaces != NULL && (uintptr_t)segment->surfaces % _Alignof(narsil_frozen_strings) != 0) ||
      (segment->spellings != NULL && (uintptr_t)segment->spellings % _Alignof(narsil_frozen_strings) != 0)) {
    return NARSIL_INVALID_ARGUMENT;
  }
  segment_regions regions = {0};
  if (!state_regions(&regions, request) || !source_regions(&regions, segment) ||
      !segment_region_input(&regions, request, 1, sizeof *request) ||
      !segment_region_input(&regions, request->state, 1, sizeof *request->state) ||
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

narsil_status frozen_removal_output_regions(const narsil_remove_frozen_request *request,
                                            const narsil_frozen_removal_output *output, size_t *count) {
  if (output == NULL || (uintptr_t)output % _Alignof(narsil_frozen_removal_output) != 0 ||
      output->entry_capacity > SIZE_MAX / 2) {
    return NARSIL_INVALID_ARGUMENT;
  }
  segment_regions regions = {0};
  if (!state_regions(&regions, request) ||
      !segment_region_write(&regions, output->entries, output->entry_capacity * 2, sizeof *output->entries) ||
      !segment_region_write(&regions, output->values, output->value_capacity, sizeof *output->values) ||
      !segment_region_write(&regions, count, 1, sizeof *count)) {
    return NARSIL_INVALID_ARGUMENT;
  }
  for (size_t at = 0; at < regions.write_count; at++) {
    for (size_t prior = 0; prior < at; prior++) {
      if (overlaps(regions.writes[at], regions.writes[prior])) { return NARSIL_INVALID_ARGUMENT; }
    }
  }
  if (!source_regions(&regions, request->segment) || !segment_region_input(&regions, request, 1, sizeof *request) ||
      !segment_region_input(&regions, request->state, 1, sizeof *request->state) ||
      !segment_region_input(&regions, output, 1, sizeof *output) ||
      !segment_region_input(&regions, request->fields, request->field_count, sizeof *request->fields)) {
    return NARSIL_INVALID_ARGUMENT;
  }
  for (size_t at = 0; at < request->field_count; at++) {
    if (!segment_valid_tokens(&regions, &request->fields[at].tokens)) { return NARSIL_INVALID_ARGUMENT; }
  }
  return NARSIL_OK;
}
