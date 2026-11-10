#include "file.h"
#include "frozen_segment.h"
#include "input.h"
#include "segment.h"
#include "terms.h"

#include "../include/narsil_analysis.h"
#include "../include/narsil_core.h"
#include "../include/narsil_expansion.h"
#include "../include/narsil_frozen_segments.h"
#include "../include/narsil_paged.h"
#include "../include/narsil_posting_merge.h"
#include "../include/narsil_segment_merge.h"
#include "../include/narsil_segments.h"
#include "../include/narsil_terms.h"
#include "../src/segments/frozen.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

enum {
  MAX_OPERATIONS = 10,
  MAX_REMOVAL_OUTPUT = 64,
  RECORD_PAGE_BYTES = 16384,
  MAX_SECTION_PAGES = 2,
  SURFACE_CHOICES = 3,
  UNITS_PER_TOKEN = FUZZ_FROZEN_MAX_WORD_UNITS * 2,
  CAPITAL_SHIFT = 'a' - 'A',
  MERGE_INPUTS = 2,
  DROP_CHOICES = 4,
  POSTING_TOTALS = 2
};

enum {
  REMOVE,
  PREPARE,
  RECORD,
  SETTLE,
  LOOKUP,
  EXACT_BATCH,
  FREQUENCY,
  PREFIX,
  PARTIAL,
  SUGGEST,
  MERGE,
  POSTINGS,
  KINDS
};

#define DROPPED_DOCUMENT UINT32_MAX

typedef struct {
  narsil_paged_file *file;
  narsil_page_section offsets;
  narsil_page_section values;
  narsil_page_fault fault;
  narsil_frozen_paged_removals removals;
  uint8_t offset_checksums[MAX_SECTION_PAGES * FUZZ_CHECKSUM_BYTES];
  uint8_t value_checksums[MAX_SECTION_PAGES * FUZZ_CHECKSUM_BYTES];
} frozen_paged;

static narsil_page_section page_section(const narsil_paged_file *file, const uint8_t *bytes, size_t offset,
                                        size_t length, uint8_t *checksums) {
  uint64_t pages = (length / RECORD_PAGE_BYTES) + (length % RECORD_PAGE_BYTES != 0);
  if (pages > MAX_SECTION_PAGES) { pages = MAX_SECTION_PAGES; }
  fuzz_page_checksums((fuzz_page_source){bytes + offset, length, length, RECORD_PAGE_BYTES}, checksums, pages);
  return (narsil_page_section){file, offset, length, RECORD_PAGE_BYTES, checksums, pages * FUZZ_CHECKSUM_BYTES};
}

static const narsil_frozen_paged_removals *open_paged(fuzz_input *input, const fuzz_frozen *frozen,
                                                      frozen_paged *paged) {
  if ((fuzz_byte(input) & 1U) == 0 || frozen->removal_file == NULL) { return NULL; }
  const char *path = fuzz_file_write(frozen->removal_file, frozen->removal_file_bytes);
  if (path == NULL || narsil_paged_file_open(path, &paged->file) != NARSIL_OK) { return NULL; }
  const uint8_t *bytes = frozen->removal_file;
  size_t heads = frozen->removal_offset_bytes;
  paged->offsets = page_section(paged->file, bytes, 0, heads, paged->offset_checksums);
  paged->values = page_section(paged->file, bytes, heads, frozen->removal_file_bytes - heads, paged->value_checksums);
  paged->removals = (narsil_frozen_paged_removals){NULL, &paged->offsets, &paged->values, &paged->fault};
  return &paged->removals;
}

static uint32_t chosen_spelling(fuzz_input *input, const fuzz_frozen *frozen, uint32_t term) {
  uint32_t matches = 0;
  for (size_t entry = 0; entry < frozen->spelling_count; entry++) { matches += frozen->spelling_terms[entry] == term; }
  if (matches == 0) { return UINT32_MAX; }
  uint32_t wanted = fuzz_below(input, matches);
  for (uint32_t entry = 0; entry < frozen->spelling_count; entry++) {
    if (frozen->spelling_terms[entry] == term && wanted-- == 0) { return entry; }
  }
  return UINT32_MAX;
}

static uint32_t append_word(uint16_t *units, uint32_t used, const fuzz_frozen_word *word, int capital) {
  for (uint32_t at = 0; at < word->length; at++) {
    units[used + at] = (uint16_t)(capital && at == 0 ? word->units[at] - CAPITAL_SHIFT : word->units[at]);
  }
  return used + word->length;
}

static narsil_token document_token(fuzz_input *input, const fuzz_frozen *frozen, uint32_t term, uint16_t *units,
                                   uint32_t *used) {
  const fuzz_frozen_word *word = &frozen->terms[term];
  narsil_token token = {0, *used, word->length, NARSIL_NO_SURFACE, 0, *used, word->length, NARSIL_NO_TERM_SLOT};
  *used = append_word(units, *used, word, 0);
  uint32_t choice = fuzz_below(input, SURFACE_CHOICES);
  uint32_t spelling = choice == 2 ? chosen_spelling(input, frozen, term) : UINT32_MAX;
  if (choice == 1 || spelling != UINT32_MAX) {
    const fuzz_frozen_word *surface = choice == 1 ? word : &frozen->spelling_words[spelling];
    token.surface_offset = *used;
    token.surface_length = surface->length;
    token.original_offset = *used;
    token.original_length = surface->length;
    *used = append_word(units, *used, surface, choice == 1);
  }
  return token;
}

static int field_tokens(fuzz_input *input, const fuzz_frozen *frozen, uint32_t ordinal, uint16_t field,
                        narsil_field_tokens *tokens) {
  uint32_t count = 0;
  for (size_t row = 0; row < frozen->row_count; row++) {
    if (frozen->row_documents[row] == ordinal && frozen->row_fields[row] == field) {
      count += frozen->row_frequencies[row];
    }
  }
  if (count == 0) { return 0; }
  narsil_token *list = FUZZ_ROOM(input, narsil_token, count);
  uint16_t *units = FUZZ_ROOM(input, uint16_t, (size_t)count *UNITS_PER_TOKEN);
  if (list == NULL || units == NULL) { return 0; }
  uint32_t written = 0;
  uint32_t used = 0;
  for (size_t row = 0; row < frozen->row_count; row++) {
    if (frozen->row_documents[row] != ordinal || frozen->row_fields[row] != field) { continue; }
    for (uint16_t at = 0; at < frozen->row_frequencies[row]; at++) {
      list[written] = document_token(input, frozen, frozen->row_terms[row], units, &used);
      list[written].position = written;
      written++;
    }
  }
  *tokens = (narsil_field_tokens){field, {list, written, units, used}};
  return 1;
}

static narsil_remove_frozen_request removal(fuzz_input *input, fuzz_frozen *frozen,
                                            const narsil_frozen_paged_removals *paged) {
  narsil_frozen_segment *segment = &frozen->segment;
  uint32_t ordinal = fuzz_raw(input) ? fuzz_u32(input) : fuzz_below(input, segment->document_count);
  narsil_remove_frozen_request request = {segment, &frozen->state, ordinal, NULL, 0, paged};
  if (fuzz_raw(input)) {
    request.fields = fuzz_fields(input, segment->field_count, &request.field_count);
    return request;
  }
  narsil_field_tokens fields[FUZZ_FROZEN_MAX_FIELDS];
  for (uint16_t field = 0; field < segment->field_count && field < FUZZ_FROZEN_MAX_FIELDS; field++) {
    request.field_count += (size_t)field_tokens(input, frozen, ordinal, field, &fields[request.field_count]);
  }
  narsil_field_tokens *published = FUZZ_ROOM(input, narsil_field_tokens, request.field_count);
  if (published != NULL && request.field_count > 0) {
    memcpy(published, fields, request.field_count * sizeof *published);
  }
  request.fields = published;
  return request;
}

static narsil_frozen_removal_output removal_output(fuzz_input *input) {
  size_t entries = fuzz_below(input, MAX_REMOVAL_OUTPUT + 1);
  size_t values = fuzz_below(input, MAX_REMOVAL_OUTPUT + 1);
  return (narsil_frozen_removal_output){FUZZ_ROOM(input, uint32_t, entries * 2), FUZZ_ROOM(input, double, values),
                                        entries, values};
}

static void prepare(narsil_workspace *workspace, fuzz_input *input, const narsil_remove_frozen_request *request) {
  narsil_frozen_removal_output output = removal_output(input);
  size_t *count = FUZZ_ROOM(input, size_t, 1);
  if (input->exhausted_memory) { return; }
  (void)narsil_prepare_frozen_removal(workspace, request, &output, count);
}

static void record(fuzz_input *input, const fuzz_frozen *frozen, const narsil_remove_frozen_request *request) {
  const narsil_frozen_segment *full = &frozen->segment;
  const narsil_frozen_segment_state *held = &frozen->state;
  narsil_frozen_segment segment = {
      .partial_fields = full->partial_fields, .field_count = full->field_count, .document_count = full->document_count};
  narsil_frozen_segment_state state = {.tombstones = held->tombstones,
                                       .tombstone_count = held->tombstone_count,
                                       .pending_header = held->pending_header,
                                       .pending_documents = held->pending_documents,
                                       .pending_document_capacity = held->pending_document_capacity,
                                       .pending_tokens = held->pending_tokens,
                                       .pending_token_capacity = held->pending_token_capacity,
                                       .pending_units = held->pending_units,
                                       .pending_unit_capacity = held->pending_unit_capacity};
  narsil_remove_frozen_request recorded = {&segment, &state, request->ordinal, request->fields, request->field_count,
                                           NULL};
  narsil_frozen_removal_output output = removal_output(input);
  size_t *count = FUZZ_ROOM(input, size_t, 1);
  if (input->exhausted_memory) { return; }
  (void)frozen_record_prepared_removal(&recorded, &output, count);
}

static narsil_keyword_merge_input merge_input(fuzz_input *input, const fuzz_frozen *frozen, uint32_t *target) {
  const narsil_frozen_segment *segment = &frozen->segment;
  uint32_t documents = segment->document_count;
  uint32_t fields = segment->field_count;
  uint32_t *mapping = FUZZ_ARRAY(input, uint32_t, documents);
  uint16_t *field_mapping = FUZZ_ROOM(input, uint16_t, fields);
  const uint32_t **lengths = FUZZ_ROOM(input, const uint32_t *, fields);
  narsil_keyword_merge_input source = {.terms = segment->terms,
                                       .payload_slots = segment->payload_slots,
                                       .posting_offsets = segment->posting_offsets,
                                       .posting_documents = segment->posting_documents,
                                       .posting_frequencies = segment->posting_frequencies,
                                       .posting_fields = segment->posting_fields,
                                       .posting_count = segment->posting_count,
                                       .mapping = mapping,
                                       .field_mapping = field_mapping,
                                       .field_lengths = lengths,
                                       .document_count = documents,
                                       .field_count = fields,
                                       .surfaces = segment->surfaces,
                                       .spellings = segment->spellings == NULL ? NULL : &frozen->paired_spellings};
  if (input->exhausted_memory) { return source; }
  int loose = fuzz_raw(input);
  for (uint32_t at = 0; at < documents && !loose; at++) {
    mapping[at] = mapping[at] % DROP_CHOICES == 0 ? DROPPED_DOCUMENT : (*target)++;
  }
  for (uint32_t field = 0; field < fields; field++) {
    field_mapping[field] = (uint16_t)field;
    lengths[field] = (fuzz_byte(input) & 1U) == 0 ? NULL : FUZZ_ARRAY(input, uint32_t, documents);
  }
  if ((fuzz_byte(input) & 1U) != 0) {
    source.position_offsets = frozen->position_offsets;
    source.position_values = frozen->position_values;
    source.position_count = frozen->position_count;
  }
  return source;
}

static void merge(narsil_workspace *workspace, fuzz_input *input, const fuzz_frozen *frozen) {
  size_t count = 1 + fuzz_below(input, MERGE_INPUTS);
  narsil_keyword_merge_input *inputs = FUZZ_ROOM(input, narsil_keyword_merge_input, count);
  if (inputs == NULL) { return; }
  uint32_t target = 0;
  for (size_t at = 0; at < count; at++) { inputs[at] = merge_input(input, frozen, &target); }
  uint32_t documents = fuzz_raw(input) ? fuzz_below(input, target + MERGE_INPUTS) : target;
  const narsil_frozen_strings *retained = (fuzz_byte(input) & 1U) == 0 ? NULL : &frozen->segment.terms;
  narsil_keyword_merge_request request = {inputs, count, documents, frozen->segment.field_count, retained};
  fuzz_merge_into(workspace, input, &request);
}

static void merge_postings(narsil_workspace *workspace, fuzz_input *input, const fuzz_frozen *frozen) {
  const narsil_frozen_segment *segment = &frozen->segment;
  uint32_t slot = fuzz_below(input, (uint32_t)segment->terms.count);
  uint32_t start = frozen->slot_starts[slot];
  uint32_t end = frozen->slot_starts[slot + 1];
  size_t count = 1 + fuzz_below(input, MERGE_INPUTS);
  narsil_keyword_merge_input *inputs = FUZZ_ROOM(input, narsil_keyword_merge_input, count);
  if (inputs == NULL) { return; }
  uint32_t target = 0;
  size_t positions = 0;
  for (size_t at = 0; at < count; at++) {
    inputs[at] = merge_input(input, frozen, &target);
    inputs[at].posting_documents = segment->posting_documents + start;
    inputs[at].posting_frequencies = segment->posting_frequencies + start;
    inputs[at].posting_fields = segment->posting_fields + start;
    inputs[at].posting_count = end - start;
    if (inputs[at].position_offsets != NULL && frozen->position_offsets != NULL) {
      inputs[at].position_offsets = frozen->position_offsets + start;
    }
    for (uint32_t row = start; row < end; row++) { positions += frozen->row_frequencies[row]; }
  }
  size_t rows = (size_t)(end - start) * count;
  if (fuzz_raw(input)) {
    rows = fuzz_below(input, (uint32_t)rows + 1);
    positions = fuzz_below(input, (uint32_t)positions + 1);
  }
  narsil_keyword_merge_request request = {inputs, count, target, segment->field_count, NULL};
  narsil_posting_merge_output output = {FUZZ_ROOM(input, uint32_t, rows),         FUZZ_ROOM(input, uint16_t, rows),
                                        FUZZ_ROOM(input, uint16_t, rows),         rows,
                                        FUZZ_ROOM(input, uint32_t, rows + 1),     rows + 1,
                                        FUZZ_ROOM(input, uint32_t, positions),    positions,
                                        FUZZ_ROOM(input, double, POSTING_TOTALS), POSTING_TOTALS};
  uint32_t *written = FUZZ_ROOM(input, uint32_t, 1);
  if (input->exhausted_memory) { return; }
  (void)narsil_merge_postings(workspace, &request, &output, written);
}

static void apply(narsil_workspace *workspace, fuzz_input *input, fuzz_frozen *frozen,
                  const narsil_frozen_paged_removals *paged, uint32_t operation) {
  const narsil_frozen_segment *segment = &frozen->segment;
  size_t terms = segment->terms.count;
  narsil_term_dictionary dictionary = {NULL,
                                       segment->terms.text,
                                       segment->terms.text_bytes,
                                       segment->terms.offsets,
                                       terms + 1,
                                       segment->terms.counts,
                                       terms,
                                       frozen->state.removed_documents,
                                       terms};
  narsil_expansion_segment source = {NULL, segment, &frozen->state, frozen->occurrences,
                                     frozen->occurrences == NULL ? 0 : terms};
  narsil_remove_frozen_request request;
  switch (operation) {
    case REMOVE:
      request = removal(input, frozen, paged);
      if (!input->exhausted_memory) { (void)narsil_remove_frozen_document(workspace, &request); }
      break;
    case PREPARE:
      request = removal(input, frozen, paged);
      prepare(workspace, input, &request);
      break;
    case RECORD:
      request = removal(input, frozen, paged);
      record(input, frozen, &request);
      break;
    case SETTLE:
      (void)narsil_settle_frozen_state(workspace, segment, &frozen->state, paged);
      break;
    case LOOKUP:
      fuzz_lookup(workspace, input, &dictionary);
      break;
    case EXACT_BATCH:
      fuzz_exact_batch(workspace, input, &dictionary);
      break;
    case FREQUENCY:
      fuzz_frequency(input, &dictionary, (uint32_t)terms);
      break;
    case PREFIX:
      fuzz_prefix(workspace, input, &source);
      break;
    case PARTIAL:
      fuzz_partial(workspace, input, &source, &frozen->runs);
      break;
    case SUGGEST:
      fuzz_suggest(workspace, input, &source);
      break;
    case MERGE:
      merge(workspace, input, frozen);
      break;
    default:
      merge_postings(workspace, input, frozen);
      break;
  }
}

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
  narsil_workspace *workspace = NULL;
  if (narsil_workspace_create(&workspace) != NARSIL_OK) { return 0; }
  fuzz_input input = fuzz_begin(data, size);
  fuzz_frozen *frozen = fuzz_frozen_create(&input);
  frozen_paged paged = {0};
  const narsil_frozen_paged_removals *removals = frozen == NULL ? NULL : open_paged(&input, frozen, &paged);
  uint32_t operations = 1 + fuzz_below(&input, MAX_OPERATIONS);
  for (uint32_t at = 0; frozen != NULL && at < operations && !input.exhausted_memory; at++) {
    apply(workspace, &input, frozen, removals, fuzz_below(&input, KINDS));
  }
  (void)narsil_workspace_bytes(workspace);
  narsil_workspace_destroy(workspace);
  narsil_paged_file_close(paged.file);
  fuzz_release(&input);
  return 0;
}
