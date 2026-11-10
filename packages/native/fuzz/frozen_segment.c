#include "frozen_segment.h"

#include "frozen_spellings.h"
#include "input.h"

#include "../include/narsil_expansion.h"
#include "../include/narsil_frozen_segments.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

enum {
  UNIVERSE_WORDS = 84,
  UNIVERSE_WORD_UNITS = 3,
  CAPITAL_SHIFT = 'a' - 'A',
  MAX_TERM_GAP = 8,
  MAX_DOCUMENTS = 24,
  MAX_DOCUMENT_GAP = 4,
  MAX_FREQUENCY = 4,
  MAX_POSITION_STEP = 3,
  MAX_PIECES = FUZZ_FROZEN_MAX_SPELLINGS * 2,
  MAX_TEXT_BYTES = MAX_PIECES * FUZZ_FROZEN_MAX_WORD_UNITS,
  MAX_REMOVAL_WORDS = MAX_DOCUMENTS + 1 + (MAX_DOCUMENTS * FUZZ_FROZEN_MAX_TERMS * 2),
  MAX_SURFACE_COUNT = 4,
  MAX_SPELLING_COUNT = 3,
  PENDING_TOKENS = 64,
  PENDING_UNITS = 256,
  WORD_BYTES = 4,
  PAIRED_STRIDE = 2
};

typedef struct {
  size_t terms;
  uint32_t documents;
  uint32_t fields;
  uint32_t slots[FUZZ_FROZEN_MAX_TERMS];
  uint32_t term_of_slot[FUZZ_FROZEN_MAX_TERMS];
  uint32_t document_counts[FUZZ_FROZEN_MAX_TERMS];
} frozen_draft;

typedef struct {
  const fuzz_frozen_word *words[MAX_PIECES];
  int capital[MAX_PIECES];
  size_t count;
} text_pieces;

static fuzz_frozen_word universe[UNIVERSE_WORDS];
static size_t universe_count;

static void grow_universe(void) {
  fuzz_frozen_word word = {{FUZZ_FROZEN_FIRST_LETTER}, 1};
  while (word.length > 0 && universe_count < UNIVERSE_WORDS) {
    universe[universe_count++] = word;
    if (word.length < UNIVERSE_WORD_UNITS) {
      word.units[word.length++] = FUZZ_FROZEN_FIRST_LETTER;
      continue;
    }
    while (word.length > 0 && word.units[word.length - 1] == FUZZ_FROZEN_FIRST_LETTER + FUZZ_FROZEN_LETTERS - 1) {
      word.length--;
    }
    if (word.length > 0) { word.units[word.length - 1]++; }
  }
}

static void *publish(fuzz_input *input, const void *source, size_t count, size_t width) {
  void *copy = fuzz_room(input, count, width);
  if (copy == NULL) { return NULL; }
  if (count > 0) { memcpy(copy, source, count * width); }
  fuzz_disturb(input, copy, count * width);
  return copy;
}

static void add_piece(text_pieces *pieces, const fuzz_frozen_word *word, int capital) {
  pieces->words[pieces->count] = word;
  pieces->capital[pieces->count++] = capital;
}

static narsil_frozen_strings publish_strings(fuzz_input *input, const text_pieces *pieces, const uint32_t *counts,
                                             size_t count) {
  uint8_t text[MAX_TEXT_BYTES];
  uint32_t offsets[MAX_PIECES + 1];
  size_t used = 0;
  for (size_t at = 0; at < pieces->count; at++) {
    offsets[at] = (uint32_t)used;
    const fuzz_frozen_word *word = pieces->words[at];
    for (uint32_t unit = 0; unit < word->length; unit++) {
      int capital = unit == 0 && pieces->capital[at];
      text[used++] = (uint8_t)(capital ? word->units[unit] - CAPITAL_SHIFT : word->units[unit]);
    }
  }
  offsets[pieces->count] = (uint32_t)used;
  narsil_frozen_strings strings = {NULL, used, NULL, NULL, count};
  strings.text = publish(input, text, used, sizeof *text);
  strings.offsets = publish(input, offsets, pieces->count + 1, sizeof *offsets);
  strings.counts = publish(input, counts, count, sizeof *counts);
  return strings;
}

static void choose_terms(fuzz_input *input, fuzz_frozen *frozen, frozen_draft *draft) {
  size_t limit = 1 + fuzz_below(input, FUZZ_FROZEN_MAX_TERMS);
  size_t word = fuzz_below(input, MAX_TERM_GAP);
  while (draft->terms < limit && word < universe_count) {
    frozen->terms[draft->terms++] = universe[word];
    word += 1 + fuzz_below(input, MAX_TERM_GAP);
  }
  for (uint32_t at = 0; at < draft->terms; at++) { draft->slots[at] = at; }
  for (size_t at = draft->terms; (fuzz_byte(input) & 1U) != 0 && at > 1; at--) {
    uint32_t other = fuzz_below(input, (uint32_t)at);
    uint32_t held = draft->slots[at - 1];
    draft->slots[at - 1] = draft->slots[other];
    draft->slots[other] = held;
  }
  for (uint32_t term = 0; term < draft->terms; term++) { draft->term_of_slot[draft->slots[term]] = term; }
}

typedef struct {
  uint32_t document;
  uint32_t term;
  uint16_t field;
  uint16_t frequency;
} posting_row;

static void add_row(fuzz_frozen *frozen, posting_row posting) {
  size_t row = frozen->row_count++;
  frozen->row_documents[row] = posting.document;
  frozen->row_terms[row] = posting.term;
  frozen->row_fields[row] = posting.field;
  frozen->row_frequencies[row] = posting.frequency;
}

static void choose_postings(fuzz_input *input, fuzz_frozen *frozen, frozen_draft *draft) {
  uint32_t every_field = (1U << draft->fields) - 1U;
  for (size_t slot = 0; slot < draft->terms; slot++) {
    frozen->slot_starts[slot] = (uint32_t)frozen->row_count;
    uint32_t term = draft->term_of_slot[slot];
    uint32_t wanted = 1 + fuzz_below(input, FUZZ_FROZEN_MAX_LIST_DOCUMENTS);
    uint32_t document = fuzz_below(input, draft->documents);
    uint32_t listed = 0;
    while (listed < wanted && document < draft->documents) {
      uint8_t choice = fuzz_byte(input);
      uint32_t fields = choice & every_field;
      if (fields == 0) { fields = 1U << (choice % draft->fields); }
      for (uint32_t field = 0; field < draft->fields; field++) {
        if ((fields & (1U << field)) == 0) { continue; }
        uint16_t frequency = (uint16_t)(1 + fuzz_below(input, MAX_FREQUENCY));
        add_row(frozen, (posting_row){document, term, (uint16_t)field, frequency});
      }
      listed++;
      document += 1 + fuzz_below(input, MAX_DOCUMENT_GAP);
    }
    draft->document_counts[term] = listed;
  }
  frozen->slot_starts[draft->terms] = (uint32_t)frozen->row_count;
}

static narsil_frozen_runs publish_runs(fuzz_input *input, const fuzz_frozen *frozen) {
  fuzz_frozen_run pairs[FUZZ_FROZEN_MAX_RUN_PAIRS];
  size_t count = fuzz_frozen_collect_runs(frozen, pairs);
  if (count == 0) { return (narsil_frozen_runs){NULL, 0, NULL, 0, NULL, 0}; }
  uint32_t points[FUZZ_FROZEN_MAX_RUN_PAIRS * FUZZ_FROZEN_RUN_POINTS];
  uint32_t offsets[FUZZ_FROZEN_MAX_RUN_PAIRS + 1];
  uint32_t members[FUZZ_FROZEN_MAX_RUN_PAIRS];
  size_t runs = 0;
  for (size_t at = 0; at < count; at++) {
    if (at == 0 || memcmp(pairs[at].points, pairs[at - 1].points, sizeof pairs[at].points) != 0) {
      offsets[runs] = (uint32_t)at;
      memcpy(points + (runs * FUZZ_FROZEN_RUN_POINTS), pairs[at].points, sizeof pairs[at].points);
      runs++;
    }
    members[at] = pairs[at].entry;
  }
  offsets[runs] = (uint32_t)count;
  narsil_frozen_runs published = {NULL, runs * FUZZ_FROZEN_RUN_POINTS, NULL, runs + 1, NULL, count};
  published.points = publish(input, points, runs * FUZZ_FROZEN_RUN_POINTS, sizeof *points);
  published.offsets = publish(input, offsets, runs + 1, sizeof *offsets);
  published.members = publish(input, members, count, sizeof *members);
  return published;
}

static void publish_postings(fuzz_input *input, fuzz_frozen *frozen, const frozen_draft *draft) {
  narsil_frozen_segment *segment = &frozen->segment;
  text_pieces pieces = {{NULL}, {0}, 0};
  for (size_t term = 0; term < draft->terms; term++) { add_piece(&pieces, &frozen->terms[term], 0); }
  size_t rows = frozen->row_count;
  segment->terms = publish_strings(input, &pieces, draft->document_counts, draft->terms);
  segment->payload_slots = publish(input, draft->slots, draft->terms, sizeof *draft->slots);
  segment->posting_offsets = publish(input, frozen->slot_starts, draft->terms + 1, sizeof *frozen->slot_starts);
  segment->posting_documents = publish(input, frozen->row_documents, rows, sizeof *frozen->row_documents);
  segment->posting_frequencies = publish(input, frozen->row_frequencies, rows, sizeof *frozen->row_frequencies);
  segment->posting_fields = publish(input, frozen->row_fields, rows, sizeof *frozen->row_fields);
  segment->posting_count = rows;
  segment->field_count = draft->fields;
  segment->document_count = draft->documents;
  uint32_t offsets[FUZZ_FROZEN_MAX_ROWS + 1];
  uint32_t values[FUZZ_FROZEN_MAX_ROWS * MAX_FREQUENCY];
  size_t used = 0;
  for (size_t row = 0; row < rows; row++) {
    offsets[row] = (uint32_t)used;
    uint32_t position = fuzz_below(input, MAX_POSITION_STEP);
    for (uint16_t at = 0; at < frozen->row_frequencies[row]; at++) {
      values[used++] = position;
      position += 1 + fuzz_below(input, MAX_POSITION_STEP);
    }
  }
  offsets[rows] = (uint32_t)used;
  frozen->position_offsets = publish(input, offsets, rows + 1, sizeof *offsets);
  frozen->position_values = publish(input, values, used, sizeof *values);
  frozen->position_count = used;
  double occurrences[FUZZ_FROZEN_MAX_TERMS] = {0};
  for (size_t slot = 0; slot < draft->terms; slot++) {
    for (size_t row = frozen->slot_starts[slot]; row < frozen->slot_starts[slot + 1]; row++) {
      occurrences[slot] += frozen->row_frequencies[row];
    }
  }
  int counted = (fuzz_byte(input) & 1U) != 0;
  frozen->occurrences = counted ? publish(input, occurrences, draft->terms, sizeof *occurrences) : NULL;
}

static void publish_surfaces(fuzz_input *input, fuzz_frozen *frozen, size_t terms) {
  if ((fuzz_byte(input) & 1U) == 0) { return; }
  text_pieces pieces = {{NULL}, {0}, 0};
  uint32_t counts[FUZZ_FROZEN_MAX_TERMS];
  size_t count = 0;
  for (size_t term = 0; term < terms; term++) {
    if ((fuzz_byte(input) & 1U) == 0) { continue; }
    add_piece(&pieces, &frozen->terms[term], 1);
    add_piece(&pieces, &frozen->terms[term], 0);
    counts[count++] = 1 + fuzz_below(input, MAX_SURFACE_COUNT);
  }
  frozen->surfaces = publish_strings(input, &pieces, counts, count);
  frozen->segment.surfaces = &frozen->surfaces;
}

static void publish_spellings(fuzz_input *input, fuzz_frozen *frozen, int with_spellings) {
  narsil_frozen_segment *segment = &frozen->segment;
  uint8_t partial[FUZZ_FROZEN_MAX_FIELDS] = {0};
  for (size_t field = 0; with_spellings && field < segment->field_count; field++) {
    partial[field] = (uint8_t)(fuzz_byte(input) & 1U);
  }
  segment->partial_fields = publish(input, partial, segment->field_count, sizeof *partial);
  if (!with_spellings) { return; }
  text_pieces single = {{NULL}, {0}, 0};
  text_pieces paired = {{NULL}, {0}, 0};
  uint32_t counts[FUZZ_FROZEN_MAX_SPELLINGS];
  for (size_t entry = 0; entry < frozen->spelling_count; entry++) {
    add_piece(&single, &frozen->spelling_words[entry], 0);
    add_piece(&paired, &frozen->spelling_words[entry], 0);
    add_piece(&paired, &frozen->terms[frozen->spelling_terms[entry]], 0);
    counts[entry] = 1 + fuzz_below(input, MAX_SPELLING_COUNT);
  }
  frozen->spellings = publish_strings(input, &single, counts, frozen->spelling_count);
  frozen->paired_spellings = publish_strings(input, &paired, counts, frozen->spelling_count);
  segment->spellings = &frozen->spellings;
  segment->spelling_tokens = publish(input, frozen->spelling_terms, frozen->spelling_count, sizeof(uint32_t));
  frozen->runs = publish_runs(input, frozen);
}

static void publish_removals(fuzz_input *input, fuzz_frozen *frozen, const frozen_draft *draft) {
  uint32_t starts[MAX_DOCUMENTS + 1] = {0};
  uint32_t rows[FUZZ_FROZEN_MAX_ROWS];
  for (size_t row = 0; row < frozen->row_count; row++) { starts[frozen->row_documents[row] + 1]++; }
  for (size_t document = 0; document < draft->documents; document++) { starts[document + 1] += starts[document]; }
  uint32_t cursors[MAX_DOCUMENTS];
  memcpy(cursors, starts, sizeof cursors);
  for (uint32_t row = 0; row < frozen->row_count; row++) { rows[cursors[frozen->row_documents[row]]++] = row; }
  frozen->removal_index.starts = publish(input, starts, (size_t)draft->documents + 1, sizeof *starts);
  frozen->removal_index.rows = publish(input, rows, frozen->row_count, sizeof *rows);
  frozen->removal_index.term_of_slot = publish(input, draft->term_of_slot, draft->terms, sizeof *draft->term_of_slot);
  frozen->segment.removal_index = (fuzz_byte(input) & 1U) != 0 ? &frozen->removal_index : NULL;
  uint32_t words[MAX_REMOVAL_WORDS];
  size_t heads = (size_t)draft->documents + 1;
  size_t used = heads;
  for (uint32_t document = 0; document < draft->documents; document++) {
    words[document] = (uint32_t)(used - heads);
    for (uint32_t term = 0; term < draft->terms; term++) {
      uint32_t amount = 0;
      for (size_t row = 0; row < frozen->row_count; row++) {
        if (frozen->row_documents[row] == document && frozen->row_terms[row] == term) {
          amount += frozen->row_frequencies[row];
        }
      }
      if (amount == 0) { continue; }
      words[used++] = term;
      words[used++] = amount;
    }
  }
  words[draft->documents] = (uint32_t)(used - heads);
  uint8_t *file = FUZZ_ROOM(input, uint8_t, used *WORD_BYTES);
  for (size_t word = 0; file != NULL && word < used; word++) {
    fuzz_store_u32(file + (word * WORD_BYTES), words[word]);
  }
  fuzz_disturb(input, file, used * WORD_BYTES);
  frozen->removal_file = file;
  frozen->removal_file_bytes = used * WORD_BYTES;
  frozen->removal_offset_bytes = heads * WORD_BYTES;
}

static void build_state(fuzz_input *input, fuzz_frozen *frozen) {
  const narsil_frozen_segment *segment = &frozen->segment;
  size_t documents = segment->document_count;
  size_t words = fuzz_nonempty_bit_words(documents);
  size_t terms = segment->terms.count;
  size_t pending = fuzz_raw(input) ? fuzz_below(input, (uint32_t)documents + 1) : documents;
  narsil_frozen_segment_state *state = &frozen->state;
  state->tombstones = FUZZ_ZEROED(input, uint32_t, words);
  state->tombstone_count = FUZZ_ZEROED(input, uint32_t, 1);
  state->removed_documents = FUZZ_ZEROED(input, uint32_t, terms);
  state->removed_occurrences = FUZZ_ZEROED(input, double, terms);
  state->removed_surfaces = FUZZ_ZEROED(input, uint32_t, segment->surfaces == NULL ? 0 : segment->surfaces->count);
  state->removed_spellings = FUZZ_ZEROED(input, uint32_t, segment->spellings == NULL ? 0 : segment->spellings->count);
  state->pending_header = FUZZ_ZEROED(input, uint32_t, NARSIL_PENDING_HEADER_WORDS);
  state->pending_documents = FUZZ_ZEROED(input, uint32_t, pending);
  state->pending_document_capacity = pending;
  state->pending_tokens = FUZZ_ZEROED(input, uint32_t, (size_t)PENDING_TOKENS *NARSIL_PENDING_TOKEN_WORDS);
  state->pending_token_capacity = PENDING_TOKENS;
  state->pending_units = FUZZ_ZEROED(input, uint16_t, PENDING_UNITS);
  state->pending_unit_capacity = PENDING_UNITS;
}

fuzz_frozen *fuzz_frozen_create(fuzz_input *input) {
  if (universe_count == 0) { grow_universe(); }
  fuzz_frozen *frozen = FUZZ_ZEROED(input, fuzz_frozen, 1);
  if (frozen == NULL) { return NULL; }
  frozen_draft draft = {0};
  draft.documents = 1 + fuzz_below(input, MAX_DOCUMENTS);
  draft.fields = 1 + fuzz_below(input, FUZZ_FROZEN_MAX_FIELDS);
  choose_terms(input, frozen, &draft);
  choose_postings(input, frozen, &draft);
  int with_spellings = (fuzz_byte(input) & 1U) != 0;
  if (with_spellings) { fuzz_frozen_choose_spellings(input, frozen, draft.terms); }
  publish_postings(input, frozen, &draft);
  publish_surfaces(input, frozen, draft.terms);
  publish_spellings(input, frozen, with_spellings);
  publish_removals(input, frozen, &draft);
  build_state(input, frozen);
  return input->exhausted_memory ? NULL : frozen;
}
