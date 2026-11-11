#include "segment.h"

#include "input.h"

#include "../include/narsil_analysis.h"
#include "../include/narsil_segments.h"
#include "../include/narsil_terms.h"

#include <stddef.h>
#include <stdint.h>

enum {
  HEADER_WORDS = 8,
  HEAD_COUNT = 65536,
  SLOT_CAPACITY_WORD = 2,
  MAX_TERMS = 32,
  MAX_SLOT_SHIFT = 6,
  MAX_UNITS = 512,
  MAX_POOL = 256,
  MAX_POSITIONS = 512,
  LARGE_TERMS = 2048,
  LARGE_SLOT_SHIFT = 12,
  LARGE_UNITS = 16384,
  LARGE_POOL = 4096,
  LARGE_POSITIONS = 32768,
  LARGE_RUNS = 2048,
  LARGE_RUN_MEMBERS = 4096,
  LARGE_CHOICES = 8,
  MAX_CLASSES = 12,
  MAX_ORDINALS = 64,
  MAX_FIELDS = 3,
  MAX_RUNS = 32,
  MAX_RUN_MEMBERS = 256,
  POOL_WORDS = 2,
  RUN_WORDS = 3,
  MAX_TOKENS = 8,
  MAX_TOKEN_UNITS = 24,
  MAX_WORD_UNITS = 4,
  MAX_POSITION_STEP = 3,
  LETTERS = 4,
  FIRST_LETTER = 'a',
  OTHER_UNIT_MASK = 0xF000,
  HAS_POSITIONS = 1,
  HAS_SURFACES = 2,
  HAS_SPELLINGS = 4
};

#define NO_FREE_SLICE UINT32_MAX

typedef struct {
  size_t terms;
  uint32_t slot_shift;
  size_t units;
  size_t pool;
  size_t positions;
  size_t runs;
  size_t run_members;
} segment_limits;

static const segment_limits SMALL_LIMITS = {MAX_TERMS,     MAX_SLOT_SHIFT, MAX_UNITS,      MAX_POOL,
                                            MAX_POSITIONS, MAX_RUNS,       MAX_RUN_MEMBERS};
static const segment_limits LARGE_LIMITS = {LARGE_TERMS,     LARGE_SLOT_SHIFT, LARGE_UNITS,      LARGE_POOL,
                                            LARGE_POSITIONS, LARGE_RUNS,       LARGE_RUN_MEMBERS};

static size_t fuzz_capacity(fuzz_input *input, size_t limit) {
  return fuzz_raw(input) ? fuzz_count(input, limit) : limit;
}

static size_t power_of_two(fuzz_input *input, uint32_t shift) {
  return (size_t)2 << (fuzz_raw(input) ? fuzz_below(input, shift) : shift - 1);
}

static narsil_term_table term_table(fuzz_input *input, const segment_limits *limits, size_t terms) {
  size_t slots = power_of_two(input, limits->slot_shift);
  size_t units = fuzz_capacity(input, limits->units);
  uint32_t *header = FUZZ_ZEROED(input, uint32_t, HEADER_WORDS);
  if (header != NULL) { header[SLOT_CAPACITY_WORD] = (uint32_t)slots; }
  return (narsil_term_table){header,
                             HEADER_WORDS,
                             FUZZ_ZEROED(input, int32_t, slots),
                             slots,
                             FUZZ_ZEROED(input, uint32_t, terms),
                             terms,
                             FUZZ_ZEROED(input, uint32_t, terms),
                             terms,
                             FUZZ_ZEROED(input, uint32_t, terms),
                             terms,
                             FUZZ_ZEROED(input, uint32_t, HEAD_COUNT),
                             HEAD_COUNT,
                             FUZZ_ZEROED(input, uint16_t, units),
                             units};
}

static const uint32_t *slice_capacities(fuzz_input *input, size_t classes) {
  uint32_t *capacities = FUZZ_ARRAY(input, uint32_t, classes);
  if (capacities == NULL || fuzz_raw(input)) { return capacities; }
  for (size_t at = 0; at < classes; at++) { capacities[at] = UINT32_C(1) << at; }
  return capacities;
}

static narsil_slice_allocator slice_allocator(fuzz_input *input, const uint32_t *capacities, size_t classes) {
  uint32_t *free_heads = FUZZ_ROOM(input, uint32_t, classes);
  for (size_t at = 0; free_heads != NULL && at < classes; at++) { free_heads[at] = NO_FREE_SLICE; }
  return (narsil_slice_allocator){FUZZ_ZEROED(input, uint32_t, POOL_WORDS), free_heads, capacities, classes};
}

static narsil_surface_table surface_table(fuzz_input *input, const segment_limits *limits) {
  size_t terms = 1 + fuzz_capacity(input, limits->terms - 1);
  return (narsil_surface_table){term_table(input, limits, terms), FUZZ_ZEROED(input, uint32_t, terms),
                                FUZZ_ZEROED(input, uint32_t, terms), terms};
}

static narsil_run_table run_table(fuzz_input *input, const segment_limits *limits, const uint32_t *capacities,
                                  size_t classes) {
  size_t slots = power_of_two(input, limits->slot_shift);
  size_t runs = fuzz_capacity(input, limits->runs);
  size_t members = fuzz_capacity(input, limits->run_members);
  uint32_t *header = FUZZ_ZEROED(input, uint32_t, HEADER_WORDS);
  if (header != NULL) { header[SLOT_CAPACITY_WORD] = (uint32_t)slots; }
  return (narsil_run_table){header,
                            FUZZ_ZEROED(input, int32_t, slots),
                            slots,
                            FUZZ_ZEROED(input, uint32_t, runs *RUN_WORDS),
                            FUZZ_ZEROED(input, uint32_t, runs),
                            FUZZ_ZEROED(input, uint32_t, runs),
                            FUZZ_ZEROED(input, uint8_t, runs),
                            runs,
                            FUZZ_ZEROED(input, uint32_t, members),
                            members,
                            slice_allocator(input, capacities, classes)};
}

static narsil_term_columns term_columns(fuzz_input *input, size_t terms) {
  return (narsil_term_columns){FUZZ_ZEROED(input, uint32_t, terms), FUZZ_ZEROED(input, uint8_t, terms),
                               FUZZ_ZEROED(input, uint32_t, terms), FUZZ_ZEROED(input, uint32_t, terms),
                               FUZZ_ZEROED(input, uint32_t, terms), FUZZ_ZEROED(input, double, terms),
                               FUZZ_ZEROED(input, double, terms),   FUZZ_ZEROED(input, uint32_t, terms),
                               FUZZ_ZEROED(input, uint8_t, terms),  terms};
}

static void attach_optional(fuzz_input *input, fuzz_growing *growing, const segment_limits *limits,
                            const uint32_t *capacities, size_t classes) {
  uint8_t options = fuzz_byte(input);
  narsil_growing_segment *segment = &growing->segment;
  if ((options & HAS_POSITIONS) != 0) {
    size_t positions = fuzz_capacity(input, limits->positions);
    uint32_t *allocation = FUZZ_ZEROED(input, uint32_t, POOL_WORDS);
    if (allocation != NULL) { allocation[0] = 1; }
    growing->positions = (narsil_position_pool){FUZZ_ZEROED(input, uint32_t, positions), positions, allocation};
    segment->positions = &growing->positions;
  }
  if ((options & HAS_SURFACES) != 0) {
    growing->surfaces = surface_table(input, limits);
    segment->surfaces = &growing->surfaces;
  }
  if ((options & HAS_SPELLINGS) != 0) {
    growing->spellings.entries = surface_table(input, limits);
    growing->spellings.code_points = FUZZ_ZEROED(input, uint32_t, growing->spellings.entries.capacity);
    growing->spellings.runs = run_table(input, limits, capacities, classes);
    segment->spellings = &growing->spellings;
  }
}

fuzz_growing *fuzz_growing_create(fuzz_input *input) {
  fuzz_growing *growing = FUZZ_ZEROED(input, fuzz_growing, 1);
  if (growing == NULL) { return NULL; }
  growing->large = fuzz_below(input, LARGE_CHOICES) == 0;
  const segment_limits *limits = growing->large ? &LARGE_LIMITS : &SMALL_LIMITS;
  size_t terms = 1 + fuzz_capacity(input, limits->terms - 1);
  size_t classes = 1 + fuzz_capacity(input, MAX_CLASSES - 1);
  const uint32_t *capacities = slice_capacities(input, classes);
  uint32_t ordinals = 1 + fuzz_below(input, MAX_ORDINALS);
  uint32_t fields = 1 + fuzz_below(input, MAX_FIELDS);
  size_t pool = fuzz_capacity(input, limits->pool);
  narsil_growing_segment *segment = &growing->segment;
  segment->terms = term_table(input, limits, terms);
  segment->columns = term_columns(input, terms);
  segment->postings = (narsil_posting_pool){FUZZ_ZEROED(input, uint32_t, pool),
                                            FUZZ_ZEROED(input, uint16_t, pool),
                                            FUZZ_ZEROED(input, uint16_t, pool),
                                            FUZZ_ZEROED(input, uint32_t, pool),
                                            pool,
                                            slice_allocator(input, capacities, classes)};
  attach_optional(input, growing, limits, capacities, classes);
  if (segment->positions == NULL) { segment->postings.position_starts = NULL; }
  segment->retired = FUZZ_ZEROED(input, uint32_t, fuzz_bit_words(ordinals));
  segment->field_lengths = FUZZ_ZEROED(input, uint32_t, (size_t)ordinals *fields);
  segment->total_documents = FUZZ_ZEROED(input, uint32_t, 1);
  segment->total_field_lengths = FUZZ_ZEROED(input, double, fields);
  uint8_t *partial = FUZZ_ARRAY(input, uint8_t, fields);
  for (size_t at = 0; partial != NULL && at < fields; at++) {
    partial[at] = segment->spellings == NULL ? 0 : (uint8_t)(partial[at] & 1U);
  }
  segment->partial_fields = partial;
  segment->ordinal_capacity = ordinals;
  segment->field_count = fields;
  return input->exhausted_memory ? NULL : growing;
}

static void disturb_table(fuzz_input *input, const narsil_term_table *table) {
  fuzz_disturb(input, table->header, table->header_words * sizeof *table->header);
  fuzz_disturb(input, table->slots, table->slot_count * sizeof *table->slots);
  fuzz_disturb(input, table->term_offset, table->offset_count * sizeof *table->term_offset);
  fuzz_disturb(input, table->term_length, table->length_count * sizeof *table->term_length);
  fuzz_disturb(input, table->first_unit_next, table->next_count * sizeof *table->first_unit_next);
}

void fuzz_growing_disturb(fuzz_input *input, fuzz_growing *growing) {
  narsil_growing_segment *segment = &growing->segment;
  size_t terms = segment->columns.capacity;
  disturb_table(input, &segment->terms);
  fuzz_disturb(input, segment->columns.slice_start, terms * sizeof *segment->columns.slice_start);
  fuzz_disturb(input, segment->columns.slice_class, terms * sizeof *segment->columns.slice_class);
  fuzz_disturb(input, segment->columns.lengths, terms * sizeof *segment->columns.lengths);
  fuzz_disturb(input, segment->columns.doc_frequency, terms * sizeof *segment->columns.doc_frequency);
  fuzz_disturb(input, segment->postings.doc_ids, segment->postings.capacity * sizeof *segment->postings.doc_ids);
  fuzz_disturb(input, segment->postings.allocator.allocation, POOL_WORDS * sizeof(uint32_t));
  fuzz_disturb(input, segment->postings.allocator.free_heads,
               segment->postings.allocator.class_count * sizeof(uint32_t));
  if (segment->positions != NULL) {
    fuzz_disturb(input, segment->positions->allocation, POOL_WORDS * sizeof(uint32_t));
    fuzz_disturb(input, segment->postings.position_starts, segment->postings.capacity * sizeof(uint32_t));
  }
  if (segment->surfaces != NULL) { disturb_table(input, &growing->surfaces.strings); }
  if (segment->spellings != NULL) {
    disturb_table(input, &growing->spellings.entries.strings);
    fuzz_disturb(input, growing->spellings.runs.header, HEADER_WORDS * sizeof(uint32_t));
    fuzz_disturb(input, growing->spellings.runs.list_start, growing->spellings.runs.capacity * sizeof(uint32_t));
    fuzz_disturb(input, growing->spellings.runs.list_length, growing->spellings.runs.capacity * sizeof(uint32_t));
  }
}

uint16_t *fuzz_word(fuzz_input *input, size_t *length) {
  *length = fuzz_count(input, MAX_WORD_UNITS);
  uint16_t *units = FUZZ_ARRAY(input, uint16_t, *length);
  if (units == NULL || fuzz_raw(input)) { return units; }
  for (size_t at = 0; at < *length; at++) { units[at] = (uint16_t)(FIRST_LETTER + (units[at] % LETTERS)); }
  return units;
}

static void shape_token(narsil_token *token, uint32_t unit_count, uint32_t *position) {
  *position += token->position % MAX_POSITION_STEP;
  token->position = *position;
  token->term_offset %= unit_count + 1;
  token->term_length %= unit_count - token->term_offset + 1;
  if ((token->surface_offset & 1U) == 0) {
    token->surface_offset = NARSIL_NO_SURFACE;
    token->surface_length = 0;
  } else {
    token->surface_offset %= unit_count + 1;
    token->surface_length %= unit_count - token->surface_offset + 1;
  }
  token->original_offset %= unit_count + 1;
  token->original_length %= unit_count - token->original_offset + 1;
  token->term_slot = NARSIL_NO_TERM_SLOT;
}

static narsil_tokens fuzz_tokens(fuzz_input *input) {
  uint32_t unit_count = (uint32_t)fuzz_count(input, MAX_TOKEN_UNITS);
  uint32_t token_count = (uint32_t)fuzz_count(input, MAX_TOKENS);
  uint16_t *units = FUZZ_ARRAY(input, uint16_t, unit_count);
  narsil_token *tokens = FUZZ_ARRAY(input, narsil_token, token_count);
  if (!input->exhausted_memory && !fuzz_raw(input)) {
    for (uint32_t at = 0; at < unit_count; at++) {
      if ((units[at] & OTHER_UNIT_MASK) != OTHER_UNIT_MASK) {
        units[at] = (uint16_t)(FIRST_LETTER + (units[at] % LETTERS));
      }
    }
    uint32_t position = 0;
    for (uint32_t at = 0; at < token_count; at++) { shape_token(&tokens[at], unit_count, &position); }
  }
  return (narsil_tokens){tokens, token_count, units, unit_count};
}

narsil_field_tokens *fuzz_fields(fuzz_input *input, uint32_t field_count, size_t *count) {
  int loose = fuzz_raw(input);
  *count = loose ? fuzz_count(input, MAX_FIELDS + 1) : fuzz_count(input, field_count);
  narsil_field_tokens *fields = FUZZ_ROOM(input, narsil_field_tokens, *count);
  for (size_t at = 0; fields != NULL && at < *count; at++) {
    uint16_t field = loose ? (uint16_t)fuzz_below(input, field_count + 2) : (uint16_t)at;
    fields[at] = (narsil_field_tokens){field, fuzz_tokens(input)};
  }
  return fields;
}
