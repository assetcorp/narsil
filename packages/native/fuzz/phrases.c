#include "input.h"

#include "../include/narsil_core.h"
#include "../include/narsil_phrases.h"

#include <stddef.h>
#include <stdint.h>

enum {
  MAX_ORDINALS = 64,
  MAX_FIELDS = 4,
  MAX_TOKENS = 6,
  MAX_ROWS = 24,
  MAX_POSITIONS = 64,
  MAX_POSITION_VALUE = 16,
  MAX_PHRASES = 4,
  MAX_PHRASE_TOKENS = 4,
  MAX_OFFSET = 4,
  MAX_OUTPUT = 160
};

typedef struct {
  uint32_t ordinals;
  uint32_t field_count;
} row_bounds;

static void shape_rows(const narsil_phrase_postings *list, uint32_t *documents, uint16_t *fields, uint32_t *starts,
                       uint32_t *counts, row_bounds bounds) {
  uint32_t document = 0;
  for (size_t row = 0; row < list->count; row++) {
    if (list->ordered) {
      document += documents[row] % 3U;
      documents[row] = document % (bounds.ordinals + 1);
    } else {
      documents[row] %= bounds.ordinals + 1;
    }
    fields[row] = (uint16_t)(fields[row] % (bounds.field_count + 1));
    starts[row] %= (uint32_t)list->position_count + 1;
    counts[row] %= (uint32_t)(list->position_count - starts[row]) + 1;
  }
}

static narsil_phrase_postings fuzz_list(fuzz_input *input, uint32_t ordinals, uint32_t field_count) {
  narsil_phrase_postings list = {NULL,
                                 NULL,
                                 NULL,
                                 NULL,
                                 fuzz_count(input, MAX_ROWS),
                                 NULL,
                                 fuzz_count(input, MAX_POSITIONS),
                                 (int)(fuzz_byte(input) & 1U)};
  uint32_t *documents = FUZZ_ARRAY(input, uint32_t, list.count);
  uint16_t *fields = FUZZ_ARRAY(input, uint16_t, list.count);
  uint32_t *starts = FUZZ_ARRAY(input, uint32_t, list.count);
  uint32_t *counts = FUZZ_ARRAY(input, uint32_t, list.count);
  uint32_t *positions = FUZZ_ARRAY(input, uint32_t, list.position_count);
  list.documents = documents;
  list.fields = fields;
  list.position_starts = starts;
  list.position_counts = counts;
  list.positions = positions;
  if (input->exhausted_memory || fuzz_raw(input)) { return list; }
  for (size_t at = 0; at < list.position_count; at++) { positions[at] %= MAX_POSITION_VALUE; }
  shape_rows(&list, documents, fields, starts, counts, (row_bounds){ordinals, field_count});
  return list;
}

static uint32_t *phrase_starts(fuzz_input *input, size_t phrase_count, size_t *entry_count) {
  if (fuzz_raw(input)) {
    *entry_count = fuzz_count(input, (size_t)MAX_PHRASES * MAX_PHRASE_TOKENS);
    return fuzz_offsets(input, phrase_count, (uint32_t)*entry_count);
  }
  uint32_t *starts = FUZZ_ROOM(input, uint32_t, phrase_count + 1);
  *entry_count = 0;
  for (size_t phrase = 0; starts != NULL && phrase < phrase_count; phrase++) {
    starts[phrase] = (uint32_t)*entry_count;
    *entry_count += 1 + fuzz_below(input, MAX_PHRASE_TOKENS);
  }
  if (starts != NULL) { starts[phrase_count] = (uint32_t)*entry_count; }
  return starts;
}

static uint8_t *fuzz_searchable(fuzz_input *input, uint32_t field_count) {
  uint8_t *searchable = FUZZ_ARRAY(input, uint8_t, field_count);
  if (searchable == NULL || fuzz_raw(input)) { return searchable; }
  for (size_t at = 0; at < field_count; at++) { searchable[at] &= 1U; }
  return searchable;
}

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
  narsil_workspace *workspace = NULL;
  if (narsil_workspace_create(&workspace) != NARSIL_OK) { return 0; }
  fuzz_input input = fuzz_begin(data, size);
  uint32_t ordinals = fuzz_below(&input, MAX_ORDINALS + 1);
  uint32_t field_count = fuzz_below(&input, MAX_FIELDS + 1);
  size_t token_count = fuzz_count(&input, MAX_TOKENS);
  narsil_phrase_postings *postings = FUZZ_ROOM(&input, narsil_phrase_postings, token_count);
  for (size_t at = 0; postings != NULL && at < token_count; at++) {
    postings[at] = fuzz_list(&input, ordinals, field_count);
  }
  size_t phrase_count = fuzz_count(&input, MAX_PHRASES);
  size_t entry_count = 0;
  uint32_t *starts = phrase_starts(&input, phrase_count, &entry_count);
  uint32_t *tokens = FUZZ_ARRAY(&input, uint32_t, entry_count);
  uint32_t *offsets = FUZZ_ARRAY(&input, uint32_t, entry_count);
  int loose = fuzz_raw(&input);
  for (size_t at = 0; tokens != NULL && offsets != NULL && !loose && at < entry_count; at++) {
    tokens[at] = token_count == 0 ? 0 : tokens[at] % (uint32_t)token_count;
    offsets[at] %= MAX_OFFSET + 1;
  }
  size_t words = fuzz_nonempty_bit_words(ordinals);
  int filtered = (fuzz_byte(&input) & 1U) == 1U;
  size_t filter_words = 0;
  if (filtered) { filter_words = loose ? fuzz_count(&input, words + 1) : words; }
  size_t removed_words = loose ? fuzz_count(&input, words + 1) : words;
  fuzz_meter_state meter_state;
  narsil_phrase_request request = {postings,
                                   token_count,
                                   starts,
                                   phrase_count,
                                   tokens,
                                   offsets,
                                   entry_count,
                                   fuzz_searchable(&input, field_count),
                                   field_count,
                                   filtered ? FUZZ_ARRAY(&input, uint32_t, filter_words) : NULL,
                                   filter_words,
                                   FUZZ_ARRAY(&input, uint32_t, removed_words),
                                   removed_words,
                                   ordinals,
                                   (int)(fuzz_byte(&input) & 1U),
                                   fuzz_meter(&input, &meter_state)};
  size_t matched_words = loose ? fuzz_count(&input, words + 1) : words;
  size_t start_capacity = fuzz_count(&input, MAX_PHRASES + 2);
  size_t document_capacity = fuzz_count(&input, MAX_OUTPUT);
  size_t field_capacity = fuzz_count(&input, MAX_OUTPUT);
  size_t frequency_capacity = fuzz_count(&input, MAX_OUTPUT);
  narsil_phrase_output output = {FUZZ_ROOM(&input, uint32_t, matched_words),
                                 matched_words,
                                 FUZZ_ROOM(&input, uint32_t, start_capacity),
                                 start_capacity,
                                 FUZZ_ROOM(&input, uint32_t, document_capacity),
                                 FUZZ_ROOM(&input, uint16_t, field_capacity),
                                 FUZZ_ROOM(&input, uint32_t, frequency_capacity),
                                 document_capacity,
                                 field_capacity,
                                 frequency_capacity};
  uint32_t *rows = FUZZ_ROOM(&input, uint32_t, 1);
  if (!input.exhausted_memory) { (void)narsil_match_phrases(workspace, &request, &output, rows); }
  narsil_workspace_destroy(workspace);
  fuzz_release(&input);
  return 0;
}
