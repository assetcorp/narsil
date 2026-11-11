#include "internal.h"

#include "../../include/narsil_analysis.h"
#include "../../include/narsil_core.h"
#include "../../include/narsil_expansion.h"
#include "../../include/narsil_frozen_segments.h"
#include "../../include/narsil_segments.h"
#include "../../include/narsil_terms.h"
#include "../analysis/text.h"
#include "../terms/dictionary.h"
#include "../terms/table.h"

#include <stddef.h>
#include <stdint.h>

int expansion_dictionary(const narsil_expansion_segment *source, narsil_term_dictionary *dictionary) {
  if (source->growing != NULL) {
    const narsil_growing_segment *segment = source->growing;
    *dictionary = (narsil_term_dictionary){.growing = &segment->terms,
                                           .frequencies = segment->columns.doc_frequency,
                                           .frequency_count = segment->columns.capacity,
                                           .removed = segment->columns.dead_documents,
                                           .removed_count = segment->columns.capacity};
    return 1;
  }
  const narsil_frozen_segment *segment = source->frozen;
  if (segment == NULL || source->state == NULL) { return 0; }
  *dictionary = (narsil_term_dictionary){.tokens = segment->terms.text,
                                         .token_bytes = segment->terms.text_bytes,
                                         .offsets = segment->terms.offsets,
                                         .offset_count = segment->terms.count + 1,
                                         .frequencies = segment->terms.counts,
                                         .frequency_count = segment->terms.count,
                                         .removed = source->state->removed_documents,
                                         .removed_count = segment->terms.count,
                                         .exact_slots = segment->exact_slots,
                                         .exact_slot_count = segment->exact_slot_count};
  return 1;
}

int expansion_compare(term_cursor first, term_cursor second) {
  for (;;) {
    uint32_t left = 0;
    uint32_t right = 0;
    int left_status = term_next(&first, &left);
    int right_status = term_next(&second, &right);
    if (left_status <= 0 || right_status <= 0) { return left_status - right_status; }
    if (left != right) { return left < right ? -1 : 1; }
  }
}

int expansion_cursor_text(term_cursor cursor, narsil_text *text) {
  text->length = 0;
  uint32_t point = 0;
  int status = 0;
  while ((status = term_next(&cursor, &point)) > 0) {
    if (point >= NARSIL_HIGH_SURROGATE_FIRST && point < NARSIL_SURROGATE_END) { return NARSIL_INVALID_ARGUMENT; }
    size_t added_units = point > UINT16_MAX ? 2 : 1;
    if (text->length > NARSIL_MAX_ANALYSED_UNITS - added_units) { return NARSIL_INVALID_ARGUMENT; }
    int added = narsil_text_push_code_point(text, point);
    if (added != NARSIL_OK) { return added; }
  }
  return status < 0 ? NARSIL_INVALID_ARGUMENT : NARSIL_OK;
}

static int frozen_cursor(const narsil_frozen_strings *strings, size_t entry, term_cursor *cursor) {
  uint32_t start = strings->offsets[entry];
  uint32_t end = strings->offsets[entry + 1];
  if (start > end || end > strings->text_bytes) { return 0; }
  *cursor = (term_cursor){NULL, strings->text, start, end};
  return 1;
}

uint32_t expansion_surface_count(const narsil_expansion_segment *source) {
  if (source->growing != NULL) {
    const narsil_surface_table *table = source->growing->surfaces;
    return table == NULL ? 0 : table->strings.header[TERM_COUNT];
  }
  return source->frozen->surfaces == NULL ? 0 : (uint32_t)source->frozen->surfaces->count;
}

int expansion_surface(const narsil_expansion_segment *source, uint32_t entry, term_cursor *spelling, term_cursor *token,
                      uint32_t *count) {
  narsil_term_dictionary dictionary;
  if (!expansion_dictionary(source, &dictionary)) { return 0; }
  if (source->growing != NULL) {
    const narsil_surface_table *surfaces = source->growing->surfaces;
    if (surfaces == NULL || entry >= surfaces->strings.header[TERM_COUNT] || surfaces->count[entry] == 0) { return 0; }
    const narsil_term_table *strings = &surfaces->strings;
    uint32_t from = strings->term_offset[entry];
    uint32_t length = strings->term_length[entry];
    uint32_t used = strings->header[TERM_UNITS_USED];
    if (from > used || length > used - from || !dictionary_cursor(&dictionary, surfaces->token[entry], token)) {
      return 0;
    }
    *spelling = (term_cursor){strings->units, NULL, from, (size_t)from + length};
    *count = surfaces->count[entry];
    size_t points = 0;
    return expansion_point_count(*spelling, &points) && expansion_point_count(*token, &points);
  }
  const narsil_frozen_strings *surfaces = source->frozen->surfaces;
  if (surfaces == NULL || entry >= surfaces->count ||
      surfaces->counts[entry] <= source->state->removed_surfaces[entry]) {
    return 0;
  }
  *count = surfaces->counts[entry] - source->state->removed_surfaces[entry];
  size_t points = 0;
  return frozen_cursor(surfaces, (size_t)entry * 2, spelling) &&
         frozen_cursor(surfaces, ((size_t)entry * 2) + 1, token) && expansion_point_count(*spelling, &points) &&
         expansion_point_count(*token, &points);
}

double expansion_occurrences(const narsil_expansion_segment *source, uint32_t token, double surface_occurrences) {
  if (source->growing != NULL) {
    const narsil_term_columns *columns = &source->growing->columns;
    return columns->total_term_frequency[token] - columns->surface_occurrences[token];
  }
  const narsil_frozen_segment *segment = source->frozen;
  uint32_t slot = segment->payload_slots[token];
  if (slot >= segment->terms.count) { return 0; }
  if (source->occurrences != NULL) {
    return source->occurrences[slot] - source->state->removed_occurrences[token] - surface_occurrences;
  }
  uint32_t start = segment->posting_offsets[slot];
  uint32_t end = segment->posting_offsets[(size_t)slot + 1];
  if (start > end || end > segment->posting_count) { return 0; }
  double total = 0;
  for (size_t at = start; at < end; at++) {
    if (segment->posting_documents[at] < segment->document_count &&
        segment->posting_fields[at] < segment->field_count) {
      total += segment->posting_frequencies[at];
    }
  }
  return total - source->state->removed_occurrences[token] - surface_occurrences;
}
