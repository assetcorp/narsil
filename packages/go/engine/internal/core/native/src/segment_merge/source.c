#include "internal.h"

#include "../../include/narsil_analysis.h"
#include "../../include/narsil_core.h"
#include "../../include/narsil_segment_merge.h"
#include "../analysis/text.h"
#include "../segments/pools.h"
#include "../segments/postings.h"
#include "../terms/dictionary.h"
#include "../terms/table.h"

#include <stddef.h>
#include <stdint.h>

enum {
  UTF8_ASCII_END = 0x80,
  UTF8_TWO_END = 0x800,
  UTF8_THREE_END = 0x10000,
  UTF8_TWO_PREFIX = 0xc0,
  UTF8_THREE_PREFIX = 0xe0,
  UTF8_FOUR_PREFIX = 0xf0,
  UTF8_CONTINUATION = 0x80,
  UTF8_PAYLOAD_MASK = 0x3f,
  UTF8_PAYLOAD_BITS = 6,
  UTF8_TWO_PAYLOAD_BITS = 12,
  UTF8_THREE_PAYLOAD_BITS = 18
};

uint32_t segment_merge_term_count(const narsil_keyword_merge_input *input) {
  return input->growing == NULL ? (uint32_t)input->terms.count : input->growing->terms.header[TERM_COUNT];
}

narsil_status segment_merge_reserve_text(segment_merge_scratch *scratch, const narsil_keyword_merge_request *request) {
  size_t needed = 0;
  scratch->text_used = 0;
  for (size_t at = 0; at < request->input_count; at++) {
    const narsil_growing_segment *segment = request->inputs[at].growing;
    if (segment == NULL) { continue; }
    for (uint32_t token = 0; token < segment->terms.header[TERM_COUNT]; token++) {
      if ((segment->columns.flags[token] & SEGMENT_TERM_LIVE) == 0) { continue; }
      uint32_t from = segment->terms.term_offset[token];
      uint32_t used = segment->terms.header[TERM_UNITS_USED];
      size_t length = segment->terms.term_length[token];
      if (from > used || length > used - from || length > NARSIL_MAX_ANALYSED_UNITS) { continue; }
      if (length > (SIZE_MAX - needed) / 3) { return NARSIL_OUT_OF_MEMORY; }
      needed += length * 3;
    }
  }
  return segment_merge_reserve((void **)&scratch->text, needed, &scratch->text_capacity, sizeof *scratch->text);
}

static void append_point(segment_merge_scratch *scratch, uint32_t point) {
  uint8_t *bytes = scratch->text + scratch->text_used;
  if (point < UTF8_ASCII_END) {
    bytes[0] = (uint8_t)point;
    scratch->text_used++;
  } else if (point < UTF8_TWO_END) {
    bytes[0] = (uint8_t)(UTF8_TWO_PREFIX | (point >> UTF8_PAYLOAD_BITS));
    bytes[1] = (uint8_t)(UTF8_CONTINUATION | (point & UTF8_PAYLOAD_MASK));
    scratch->text_used += 2;
  } else if (point < UTF8_THREE_END) {
    bytes[0] = (uint8_t)(UTF8_THREE_PREFIX | (point >> UTF8_TWO_PAYLOAD_BITS));
    bytes[1] = (uint8_t)(UTF8_CONTINUATION | ((point >> UTF8_PAYLOAD_BITS) & UTF8_PAYLOAD_MASK));
    bytes[2] = (uint8_t)(UTF8_CONTINUATION | (point & UTF8_PAYLOAD_MASK));
    scratch->text_used += 3;
  } else {
    bytes[0] = (uint8_t)(UTF8_FOUR_PREFIX | (point >> UTF8_THREE_PAYLOAD_BITS));
    bytes[1] = (uint8_t)(UTF8_CONTINUATION | ((point >> UTF8_TWO_PAYLOAD_BITS) & UTF8_PAYLOAD_MASK));
    bytes[2] = (uint8_t)(UTF8_CONTINUATION | ((point >> UTF8_PAYLOAD_BITS) & UTF8_PAYLOAD_MASK));
    bytes[3] = (uint8_t)(UTF8_CONTINUATION | (point & UTF8_PAYLOAD_MASK));
    scratch->text_used += 4;
  }
}

static int growing_term(segment_merge_scratch *scratch, const narsil_growing_segment *segment, uint32_t ordinal,
                        merge_term *term) {
  const narsil_term_columns *columns = &segment->columns;
  if ((columns->flags[ordinal] & SEGMENT_TERM_LIVE) == 0) { return 0; }
  const narsil_term_table *strings = &segment->terms;
  uint32_t from = strings->term_offset[ordinal];
  uint32_t length = strings->term_length[ordinal];
  uint32_t used = strings->header[TERM_UNITS_USED];
  uint32_t start = columns->slice_start[ordinal];
  uint32_t rows = columns->lengths[ordinal];
  uint32_t end = segment->postings.allocator.allocation[SEGMENT_POOL_END];
  uint8_t kind = columns->slice_class[ordinal];
  if (length == 0 || rows == 0) { return 0; }
  if (from > used || length > used - from || length > NARSIL_MAX_ANALYSED_UNITS || end > segment->postings.capacity ||
      start > end || kind >= segment->postings.allocator.class_count ||
      segment->postings.allocator.slice_capacities[kind] > end - start ||
      rows > segment->postings.allocator.slice_capacities[kind]) {
    return 0;
  }
  term_cursor cursor = {strings->units, NULL, from, (size_t)from + length};
  size_t first = scratch->text_used;
  uint32_t point = 0;
  int next = 0;
  while ((next = term_next(&cursor, &point)) > 0) {
    if (point >= NARSIL_HIGH_SURROGATE_FIRST && point < NARSIL_SURROGATE_END) { return 0; }
    append_point(scratch, point);
  }
  if (next < 0) { return 0; }
  term->text = (merge_text){scratch->text + first, scratch->text_used - first};
  term->start = start;
  term->end = start + rows;
  return 1;
}

int segment_merge_source_term(segment_merge_scratch *scratch, const narsil_keyword_merge_input *input, uint32_t ordinal,
                              merge_term *term) {
  if (input->growing != NULL) { return growing_term(scratch, input->growing, ordinal, term); }
  uint32_t slot = input->payload_slots[ordinal];
  if (slot >= input->terms.count || !segment_merge_text(&input->terms, ordinal, &term->text)) { return 0; }
  term->start = input->posting_offsets[slot];
  term->end = input->posting_offsets[(size_t)slot + 1];
  return term->start < term->end && term->end <= input->posting_count;
}

static void frozen_positions(const narsil_keyword_merge_input *input, uint32_t row, merge_posting *posting) {
  if (input->position_offsets == NULL) { return; }
  uint32_t start = input->position_offsets[row];
  uint32_t end = input->position_offsets[(size_t)row + 1];
  if (start <= end && end <= input->position_count) {
    posting->position_start = start;
    posting->position_count = end - start;
    posting->positions = input->position_values;
  }
}

int segment_merge_source_posting(const merge_term *term, uint32_t row, merge_posting *posting) {
  const narsil_keyword_merge_input *input = term->input;
  const narsil_growing_segment *segment = input->growing;
  uint32_t document = segment == NULL ? input->posting_documents[row] : segment->postings.doc_ids[row];
  uint16_t field = segment == NULL ? input->posting_fields[row] : segment->postings.field_indices[row];
  if (document >= input->document_count || field >= input->field_count) { return 0; }
  if (input->mapping[document] == UINT32_MAX || (segment != NULL && segment_row_removed(segment, document))) {
    return 0;
  }
  *posting = (merge_posting){.input = input,
                             .row = row,
                             .target = input->mapping[document],
                             .source = term->source,
                             .field = field,
                             .frequency = segment == NULL ? input->posting_frequencies[row]
                                                          : segment->postings.frequencies[row]};
  if (segment == NULL) {
    frozen_positions(input, row, posting);
  } else if (segment->positions != NULL && (segment->columns.flags[term->ordinal] & SEGMENT_TERM_POSITIONS) != 0) {
    uint32_t start = segment->postings.position_starts[row];
    uint32_t end = segment->positions->allocation[SEGMENT_POOL_END];
    if (end > segment->positions->capacity || start >= end) { return 1; }
    if (start == 0) { return 1; }
    uint32_t count = segment->positions->values[start];
    if (count >= end - start) { return 1; }
    posting->position_start = start + 1;
    posting->position_count = count;
    posting->positions = segment->positions->values;
  }
  return 1;
}
