#include "input.h"
#include "segment.h"
#include "terms.h"

#include "../include/narsil_analysis.h"
#include "../include/narsil_core.h"
#include "../include/narsil_expansion.h"
#include "../include/narsil_segment_merge.h"
#include "../include/narsil_segments.h"
#include "../include/narsil_terms.h"

#include <stddef.h>
#include <stdint.h>

enum {
  MAX_OPERATIONS = 12,
  BULK_SPREAD_WORDS = 1024,
  BULK_EXTRA_WORDS = 128,
  BULK_REPEATS = 16384,
  BULK_EXTRA_REPEATS = 1024,
  BULK_WORD_UNITS = 6,
  BULK_LETTERS = 4,
  BULK_FIRST_LETTER = 'a'
};

enum {
  INDEX,
  REMOVE,
  BEGIN,
  END,
  LOOKUP,
  EXACT_BATCH,
  FREQUENCY,
  PREFIX,
  PARTIAL,
  SUGGEST,
  MERGE,
  BULK,
  DISTURB,
  KINDS
};

#define DROPPED_DOCUMENT UINT32_MAX

static narsil_status write_document(narsil_workspace *workspace, fuzz_input *input, fuzz_growing *growing,
                                    uint32_t operation) {
  narsil_growing_segment *segment = &growing->segment;
  size_t count = 0;
  const narsil_field_tokens *fields = fuzz_fields(input, segment->field_count, &count);
  uint32_t ordinal = fuzz_raw(input) ? fuzz_u32(input) : fuzz_below(input, segment->ordinal_capacity);
  narsil_index_terms_request request = {segment, ordinal, fields, count};
  if (input->exhausted_memory) { return NARSIL_OUT_OF_MEMORY; }
  return operation == INDEX ? narsil_index_terms(workspace, &request) : narsil_remove_document(workspace, &request);
}

static narsil_term_dictionary growing_dictionary(const fuzz_growing *growing) {
  const narsil_growing_segment *segment = &growing->segment;
  size_t count = segment->columns.capacity;
  return (narsil_term_dictionary){.growing = &segment->terms,
                                  .frequencies = segment->columns.doc_frequency,
                                  .frequency_count = count,
                                  .removed = segment->columns.dead_documents,
                                  .removed_count = count};
}

static void merge(narsil_workspace *workspace, fuzz_input *input, const fuzz_growing *growing) {
  const narsil_growing_segment *segment = &growing->segment;
  uint32_t documents = fuzz_below(input, segment->ordinal_capacity + 1);
  uint32_t fields = segment->field_count;
  uint32_t *mapping = FUZZ_ARRAY(input, uint32_t, documents);
  uint16_t *field_mapping = FUZZ_ROOM(input, uint16_t, fields);
  const uint32_t **lengths = FUZZ_ROOM(input, const uint32_t *, fields);
  if (input->exhausted_memory) { return; }
  int loose = fuzz_raw(input);
  uint32_t target = 0;
  for (uint32_t at = 0; at < documents && !loose; at++) {
    mapping[at] = (mapping[at] & 1U) == 0 ? target++ : DROPPED_DOCUMENT;
  }
  for (uint32_t field = 0; field < fields; field++) {
    field_mapping[field] = (uint16_t)field;
    lengths[field] = (fuzz_byte(input) & 1U) == 0 ? NULL : FUZZ_ARRAY(input, uint32_t, documents);
  }
  narsil_keyword_merge_input source = {.mapping = mapping,
                                       .field_mapping = field_mapping,
                                       .field_lengths = lengths,
                                       .document_count = documents,
                                       .field_count = fields,
                                       .growing = segment};
  narsil_keyword_merge_request request = {&source, 1, loose ? fuzz_below(input, documents + 1) : target, fields, NULL};
  fuzz_merge_into(workspace, input, &request);
}

static void spell_bulk_words(uint16_t *units, size_t words) {
  for (size_t word = 0; word < words; word++) {
    size_t code = word;
    for (size_t unit = 0; unit < BULK_WORD_UNITS; unit++) {
      units[(word * BULK_WORD_UNITS) + unit] = (uint16_t)(BULK_FIRST_LETTER + (code % BULK_LETTERS));
      code /= BULK_LETTERS;
    }
  }
}

static void bulk(narsil_workspace *workspace, fuzz_input *input, fuzz_growing *growing) {
  if (!growing->large) { return; }
  int repeated = (fuzz_byte(input) & 1U) != 0;
  uint32_t words = repeated ? 1 : BULK_SPREAD_WORDS + fuzz_below(input, BULK_EXTRA_WORDS);
  uint32_t count = repeated ? BULK_REPEATS + fuzz_below(input, BULK_EXTRA_REPEATS) : words;
  int surfaced = growing->segment.surfaces != NULL && (fuzz_byte(input) & 1U) != 0;
  uint16_t *units = FUZZ_ROOM(input, uint16_t, (size_t)words *BULK_WORD_UNITS);
  narsil_token *tokens = FUZZ_ROOM(input, narsil_token, count);
  if (input->exhausted_memory) { return; }
  spell_bulk_words(units, words);
  for (uint32_t at = 0; at < count; at++) {
    uint32_t offset = repeated ? 0 : at * BULK_WORD_UNITS;
    tokens[at] = (narsil_token){at,
                                offset,
                                BULK_WORD_UNITS,
                                surfaced ? offset : NARSIL_NO_SURFACE,
                                surfaced ? BULK_WORD_UNITS : 0,
                                offset,
                                BULK_WORD_UNITS,
                                NARSIL_NO_TERM_SLOT};
  }
  narsil_field_tokens field = {0, {tokens, count, units, words * (uint32_t)BULK_WORD_UNITS}};
  narsil_index_terms_request request = {&growing->segment, fuzz_below(input, growing->segment.ordinal_capacity), &field,
                                        1};
  if (narsil_index_terms(workspace, &request) != NARSIL_OK) { return; }
  if ((fuzz_byte(input) & 1U) != 0) { (void)narsil_remove_document(workspace, &request); }
  (void)narsil_end_batch(workspace, &growing->segment);
}

static void apply(narsil_workspace *workspace, fuzz_input *input, fuzz_growing *growing, uint32_t operation) {
  narsil_expansion_segment source = {&growing->segment, NULL, NULL, NULL, 0};
  narsil_frozen_runs no_runs = {NULL, 0, NULL, 0, NULL, 0};
  narsil_term_dictionary dictionary = growing_dictionary(growing);
  switch (operation) {
    case INDEX:
    case REMOVE:
      (void)write_document(workspace, input, growing, operation);
      break;
    case BEGIN:
      (void)narsil_begin_batch(workspace, &growing->segment);
      break;
    case END:
      (void)narsil_end_batch(workspace, &growing->segment);
      break;
    case LOOKUP:
      fuzz_lookup(workspace, input, &dictionary);
      break;
    case EXACT_BATCH:
      fuzz_exact_batch(workspace, input, &dictionary);
      break;
    case FREQUENCY:
      fuzz_frequency(input, &dictionary, (uint32_t)growing->segment.columns.capacity);
      break;
    case PREFIX:
      fuzz_prefix(workspace, input, &source);
      break;
    case PARTIAL:
      fuzz_partial(workspace, input, &source, &no_runs);
      break;
    case SUGGEST:
      fuzz_suggest(workspace, input, &source);
      break;
    case MERGE:
      merge(workspace, input, growing);
      break;
    case BULK:
      bulk(workspace, input, growing);
      break;
    default:
      fuzz_growing_disturb(input, growing);
      break;
  }
}

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
  narsil_workspace *workspace = NULL;
  if (narsil_workspace_create(&workspace) != NARSIL_OK) { return 0; }
  fuzz_input input = fuzz_begin(data, size);
  fuzz_growing *growing = fuzz_growing_create(&input);
  uint32_t operations = 1 + fuzz_below(&input, MAX_OPERATIONS);
  for (uint32_t at = 0; growing != NULL && at < operations && !input.exhausted_memory; at++) {
    apply(workspace, &input, growing, fuzz_below(&input, KINDS));
  }
  (void)narsil_workspace_bytes(workspace);
  narsil_workspace_destroy(workspace);
  fuzz_release(&input);
  return 0;
}
