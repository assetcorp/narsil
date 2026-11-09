#include "fixture.h"

#include "../include/narsil_analysis.h"
#include "../include/narsil_core.h"
#include "../include/narsil_expansion.h"
#include "../include/narsil_segment_merge.h"
#include "../include/narsil_segments.h"
#include "../include/narsil_suggestions.h"
#include "../include/narsil_terms.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

enum {
  TERMS = 2048,
  SLOTS = 4096,
  UNITS = 32768,
  HEADS = 65536,
  POOL = 4096,
  POSITIONS = 8192,
  CLASSES = 12,
  ORDINALS = 2048,
  FIELDS = 2,
  RUNS = 2048,
  RUN_SLOTS = 4096,
  RUN_MEMBERS = 32768
};

enum { HEADER_WORDS = 8, TERM_LENGTH = 6, SURFACE_LENGTH = 7, SURFACE_RUNS = 5, WORD_BITS = 32 };

typedef struct {
  uint32_t header[HEADER_WORDS];
  int32_t slots[SLOTS];
  uint32_t offsets[TERMS];
  uint32_t lengths[TERMS];
  uint32_t next[TERMS];
  uint32_t heads[HEADS];
  uint16_t units[UNITS];
} test_strings;

typedef struct {
  test_strings terms;
  test_strings surfaces;
  test_strings spellings;
  uint32_t surface_tokens[TERMS];
  uint32_t surface_counts[TERMS];
  uint32_t spelling_tokens[TERMS];
  uint32_t spelling_counts[TERMS];
  uint32_t spelling_points[TERMS];
  uint32_t starts[TERMS];
  uint8_t classes[TERMS];
  uint32_t lengths[TERMS];
  uint32_t frequencies[TERMS];
  uint32_t dead[TERMS];
  double occurrences[TERMS];
  double surface_occurrences[TERMS];
  uint32_t revisions[TERMS];
  uint8_t flags[TERMS];
  uint32_t docs[POOL];
  uint16_t counts[POOL];
  uint16_t fields[POOL];
  uint32_t positions_at[POOL];
  uint32_t posting_allocation[2];
  uint32_t posting_free[CLASSES];
  uint32_t sizes[CLASSES];
  uint32_t positions[POSITIONS];
  uint32_t position_allocation[2];
  uint32_t retired[ORDINALS / WORD_BITS];
  uint32_t field_lengths[ORDINALS * FIELDS];
  uint32_t documents;
  double total_lengths[FIELDS];
  uint8_t partial[FIELDS];
  uint32_t run_header[HEADER_WORDS];
  int32_t run_slots[RUN_SLOTS];
  uint32_t runs[RUNS * 3];
  uint32_t run_starts[RUNS];
  uint32_t run_lengths[RUNS];
  uint8_t run_classes[RUNS];
  uint32_t members[RUN_MEMBERS];
  uint32_t run_allocation[2];
  uint32_t run_free[CLASSES];
  narsil_surface_table surface_table;
  narsil_spelling_table spelling_table;
  narsil_position_pool position_pool;
  narsil_growing_segment segment;
} segment_fixture;

static narsil_term_table string_table(test_strings *strings) {
  strings->header[2] = SLOTS;
  return (narsil_term_table){strings->header,  HEADER_WORDS, strings->slots, SLOTS, strings->offsets, TERMS,
                             strings->lengths, TERMS,        strings->next,  TERMS, strings->heads,   HEADS,
                             strings->units,   UNITS};
}

static segment_fixture *create_segment(void) {
  segment_fixture *data = calloc(1, sizeof *data);
  if (data == NULL) { return NULL; }
  for (size_t index = 0; index < CLASSES; index++) {
    data->sizes[index] = UINT32_C(1) << index;
    data->posting_free[index] = UINT32_MAX;
    data->run_free[index] = UINT32_MAX;
  }
  data->position_allocation[0] = 1;
  data->partial[0] = 1;
  data->partial[1] = 1;
  data->surface_table =
      (narsil_surface_table){string_table(&data->surfaces), data->surface_tokens, data->surface_counts, TERMS};
  data->spelling_table.entries =
      (narsil_surface_table){string_table(&data->spellings), data->spelling_tokens, data->spelling_counts, TERMS};
  data->spelling_table.code_points = data->spelling_points;
  data->run_header[2] = RUN_SLOTS;
  data->spelling_table.runs = (narsil_run_table){data->run_header,
                                                 data->run_slots,
                                                 RUN_SLOTS,
                                                 data->runs,
                                                 data->run_starts,
                                                 data->run_lengths,
                                                 data->run_classes,
                                                 RUNS,
                                                 data->members,
                                                 RUN_MEMBERS,
                                                 {data->run_allocation, data->run_free, data->sizes, CLASSES}};
  data->position_pool = (narsil_position_pool){data->positions, POSITIONS, data->position_allocation};
  data->segment = (narsil_growing_segment){
      .terms = string_table(&data->terms),
      .columns = {data->starts, data->classes, data->lengths, data->frequencies, data->dead, data->occurrences,
                  data->surface_occurrences, data->revisions, data->flags, TERMS},
      .postings = {data->docs,
                   data->counts,
                   data->fields,
                   data->positions_at,
                   POOL,
                   {data->posting_allocation, data->posting_free, data->sizes, CLASSES}},
      .positions = &data->position_pool,
      .surfaces = &data->surface_table,
      .spellings = &data->spelling_table,
      .retired = data->retired,
      .field_lengths = data->field_lengths,
      .total_documents = &data->documents,
      .total_field_lengths = data->total_lengths,
      .partial_fields = data->partial,
      .ordinal_capacity = ORDINALS,
      .field_count = FIELDS};
  return data;
}

static void refuse_unchanged(narsil_workspace *workspace, segment_fixture *data,
                             const narsil_index_terms_request *request, narsil_status status, const char *message) {
  void *before = malloc(sizeof *data);
  check(before != NULL, "the refusal comparison has memory");
  if (before == NULL) { return; }
  memcpy(before, data, sizeof *data);
  check(narsil_index_terms(workspace, request) == status && memcmp(before, (const void *)data, sizeof *data) == 0,
        message);
  free(before);
}

static void count_boundaries(narsil_workspace *workspace, segment_fixture *data, narsil_index_terms_request request) {
  data->surface_counts[0] = UINT32_MAX - 1;
  request.ordinal = 1;
  refuse_unchanged(workspace, data, &request, NARSIL_SEGMENT_FULL,
                   "a whole document whose surface count passes uint32 remains unpublished");
  request.field_count = 1;
  check(narsil_index_terms(workspace, &request) == NARSIL_OK && data->surface_counts[0] == UINT32_MAX,
        "a surface count can reach UINT32_MAX without wrapping");
  request.ordinal = 2;
  refuse_unchanged(workspace, data, &request, NARSIL_SEGMENT_FULL,
                   "one occurrence beyond UINT32_MAX preserves all document regions");
  data->surface_counts[0] = 1;
  data->spelling_counts[0] = UINT32_MAX - 1;
  request.field_count = FIELDS;
  refuse_unchanged(workspace, data, &request, NARSIL_SEGMENT_FULL,
                   "a spelling overflow leaves earlier fields and surface counts unchanged");
  request.field_count = 1;
  check(narsil_index_terms(workspace, &request) == NARSIL_OK && data->spelling_counts[0] == UINT32_MAX,
        "a spelling count can reach UINT32_MAX");
  request.ordinal = 3;
  refuse_unchanged(workspace, data, &request, NARSIL_SEGMENT_FULL,
                   "a spelling overflow on its next document is atomic");
}

static void short_regions(narsil_workspace *workspace, const narsil_field_tokens *fields) {
  segment_fixture *data = create_segment();
  check(data != NULL, "the short-region fixture has memory");
  if (data == NULL) { return; }
  narsil_index_terms_request request = {&data->segment, 0, fields, FIELDS};
  data->segment.terms.unit_count = 0;
  refuse_unchanged(workspace, data, &request, NARSIL_NEEDS_ROOM, "short term text leaves every region unchanged");
  data->segment.terms.unit_count = UNITS;
  data->surface_table.count = data->spelling_counts;
  refuse_unchanged(workspace, data, &request, NARSIL_INVALID_ARGUMENT, "surface and spelling outputs cannot overlap");
  data->surface_table.count = data->surface_counts;
  request.ordinal = ORDINALS;
  refuse_unchanged(workspace, data, &request, NARSIL_INVALID_ARGUMENT,
                   "an ordinal outside the segment preserves every region");
  free(data);
}

static void removal_counts(narsil_workspace *workspace, const narsil_field_tokens *fields) {
  segment_fixture *data = create_segment();
  check(data != NULL, "the removal fixture has memory");
  if (data == NULL) { return; }
  narsil_index_terms_request request = {&data->segment, 0, fields, FIELDS};
  check(narsil_index_terms(workspace, &request) == NARSIL_OK, "the first removal document is indexed");
  request.ordinal = 1;
  check(narsil_index_terms(workspace, &request) == NARSIL_OK, "the second removal document is indexed");
  request.ordinal = 0;
  check(narsil_remove_document(workspace, &request) == NARSIL_OK && data->documents == 1 &&
            data->frequencies[0] - data->dead[0] == 1 && data->occurrences[0] == 2 && data->surface_counts[0] == 2 &&
            data->spelling_counts[0] == 2 && data->total_lengths[0] == 1 && data->total_lengths[1] == 1 &&
            data->field_lengths[0] == 0 && data->field_lengths[ORDINALS] == 0,
        "removal subtracts the selected document from every live keyword count");
  check(narsil_end_batch(workspace, &data->segment) == NARSIL_OK && data->lengths[0] == FIELDS &&
            data->frequencies[0] == 1 && data->dead[0] == 0 && data->documents == 1 && data->retired[0] == 1 &&
            data->surface_counts[0] == FIELDS && data->spelling_counts[0] == FIELDS,
        "a batch boundary compacts removed rows while preserving retirement and live spelling counts");
  for (size_t at = data->starts[0]; at < data->starts[0] + FIELDS; at++) {
    check(data->docs[at] == 1 && data->counts[at] == 1 && data->positions[data->positions_at[at]] == 1,
          "batch compaction retains the surviving document's posting and position pairs");
  }
  void *before = malloc(sizeof *data);
  check(before != NULL, "the malformed removal comparison has memory");
  if (before != NULL) {
    memcpy(before, data, sizeof *data);
    request.ordinal = ORDINALS;
    check(narsil_remove_document(workspace, &request) == NARSIL_INVALID_ARGUMENT &&
              memcmp(before, (const void *)data, sizeof *data) == 0,
          "an invalid removal ordinal preserves all keyword regions");
    free(before);
  }
  free(data);
}

static void batch_refusals(narsil_workspace *workspace) {
  segment_fixture *data = create_segment();
  check(data != NULL, "the batch refusal fixture has memory");
  if (data == NULL) { return; }
  data->segment.total_documents = data->frequencies;
  void *before = malloc(sizeof *data);
  check(before != NULL, "the batch refusal comparison has memory");
  if (before != NULL) {
    memcpy(before, data, sizeof *data);
    check(narsil_begin_batch(workspace, &data->segment) == NARSIL_INVALID_ARGUMENT &&
              memcmp(before, (const void *)data, sizeof *data) == 0,
          "a batch start refuses overlapping counters before publishing");
    check(narsil_end_batch(workspace, &data->segment) == NARSIL_INVALID_ARGUMENT &&
              memcmp(before, (const void *)data, sizeof *data) == 0,
          "a batch end refuses overlapping counters before publishing");
    free(before);
  }
  free(data);
}

static void compact_dictionary(narsil_workspace *workspace) {
  enum { INPUTS = 1300, KEPT = 100, TEXT_LENGTH = 9, TOKEN_LENGTH = 8, RADIX = 10, DIGITS = 4, POSITION = 2 };
  segment_fixture *data = create_segment();
  check(data != NULL, "the dictionary compaction fixture has memory");
  if (data == NULL) { return; }
  uint16_t text[TEXT_LENGTH] = {'t', 'e', 'r', 'm', '0', '0', '0', '0', 's'};
  narsil_token token = {POSITION, 0, TOKEN_LENGTH, 0, TEXT_LENGTH, 0, 0, NARSIL_NO_TERM_SLOT};
  narsil_field_tokens field = {0, {&token, 1, text, TEXT_LENGTH}};
  narsil_index_terms_request request = {&data->segment, 0, &field, 1};
  for (uint32_t pass = 0; pass < 2; pass++) {
    uint32_t count = pass == 0 ? INPUTS : INPUTS - KEPT;
    for (uint32_t ordinal = 0; ordinal < count; ordinal++) {
      uint32_t digits = ordinal;
      for (size_t at = 0; at < DIGITS; at++) {
        text[TOKEN_LENGTH - at - 1] = (uint16_t)('0' + (digits % RADIX));
        digits /= RADIX;
      }
      request.ordinal = ordinal;
      narsil_status status =
          pass == 0 ? narsil_index_terms(workspace, &request) : narsil_remove_document(workspace, &request);
      check(status == NARSIL_OK, "dictionary compaction starts with indexed and retired documents");
    }
  }
  uint32_t first = INPUTS - KEPT;
  uint32_t offset = data->terms.offsets[first];
  data->terms.offsets[first] = UINT32_MAX;
  void *before = malloc(sizeof *data);
  check(before != NULL, "the compaction refusal comparison has memory");
  if (before != NULL) {
    memcpy(before, data, sizeof *data);
    check(narsil_end_batch(workspace, &data->segment) == NARSIL_INVALID_ARGUMENT &&
              memcmp(before, (const void *)data, sizeof *data) == 0,
          "a corrupt surviving term refuses compaction before changing any region");
    free(before);
  }
  data->terms.offsets[first] = offset;
  check(narsil_end_batch(workspace, &data->segment) == NARSIL_OK && data->terms.header[0] == KEPT &&
            data->terms.header[1] == KEPT && data->terms.header[3] == 1 && data->documents == KEPT &&
            data->posting_allocation[0] == KEPT && data->posting_allocation[1] == 0 &&
            data->position_allocation[0] == 1 + (KEPT * 2) && data->position_allocation[1] == 0,
        "compaction reclaims the term dictionary and both posting pools together");
  check(data->surfaces.header[0] == KEPT && data->surfaces.header[1] == KEPT && data->spellings.header[0] == KEPT &&
            data->spellings.header[1] == KEPT,
        "compaction reclaims retired surface and spelling strings");
  for (size_t at = 0; at < KEPT; at++) {
    check(data->docs[at] == first + at && data->lengths[at] == 1 && data->frequencies[at] == 1 && data->dead[at] == 0 &&
              data->positions[data->positions_at[at]] == 1 && data->positions[data->positions_at[at] + 1] == POSITION,
          "compaction keeps each surviving document and its phrase position together");
    check(data->surface_tokens[at] == at && data->surface_counts[at] == 1 && data->spelling_tokens[at] == at &&
              data->spelling_counts[at] == 1 && data->spelling_points[at] == TEXT_LENGTH,
          "compaction preserves the token and count of each retained spelling");
  }
  for (size_t run = 0; run < data->run_header[0]; run++) {
    check(data->run_lengths[run] > 0, "compaction removes empty spelling runs");
    uint32_t start = data->run_starts[run];
    for (size_t at = start; at < (size_t)start + data->run_lengths[run]; at++) {
      check(data->members[at] < KEPT && (at == start || data->members[at - 1] < data->members[at]),
            "compaction remaps run members in ascending retained-spelling order");
    }
  }
  free(data);
}

static void posting_refusals(narsil_workspace *workspace, const narsil_field_tokens *fields) {
  segment_fixture *data = create_segment();
  check(data != NULL, "the posting refusal fixture has memory");
  if (data == NULL) { return; }
  narsil_index_terms_request request = {&data->segment, 0, fields, FIELDS};
  check(narsil_index_terms(workspace, &request) == NARSIL_OK, "the refusal source document is indexed");
  request.ordinal = 1;
  uint8_t held_class = data->classes[0];
  data->classes[0] = UINT8_MAX;
  refuse_unchanged(workspace, data, &request, NARSIL_INVALID_ARGUMENT,
                   "a missing slice for live postings cannot erase the previous document");
  data->classes[0] = held_class;
  uint32_t held_start = data->starts[0];
  data->starts[0] = POOL;
  refuse_unchanged(workspace, data, &request, NARSIL_INVALID_ARGUMENT,
                   "an invalid live slice start cannot replace earlier postings");
  data->starts[0] = held_start;
  check(narsil_index_terms(workspace, &request) == NARSIL_OK, "the refusal source term retains another document");
  held_start = data->starts[0];
  request.ordinal = 0;
  check(narsil_remove_document(workspace, &request) == NARSIL_OK, "the refusal source document is retired");
  uint32_t held_position = data->positions_at[held_start];
  data->positions_at[held_start] = data->position_allocation[0];
  refuse_unchanged(workspace, data, &request, NARSIL_INVALID_ARGUMENT,
                   "an out-of-bounds retired position prevents ordinal reuse atomically");
  data->positions_at[held_start] = held_position;
  uint32_t held_count = data->positions[held_position];
  data->positions[held_position] = UINT32_MAX;
  refuse_unchanged(workspace, data, &request, NARSIL_INVALID_ARGUMENT,
                   "an overflowing retired position span preserves the entire segment");
  data->positions[held_position] = held_count;
  check(narsil_index_terms(workspace, &request) == NARSIL_OK,
        "restoring valid position metadata permits the original ordinal reuse");
  free(data);
}

static void removal_refusals(narsil_workspace *workspace, const narsil_field_tokens *fields) {
  segment_fixture *data = create_segment();
  check(data != NULL, "the removal refusal fixture has memory");
  if (data == NULL) { return; }
  narsil_token second = fields[1].tokens.tokens[0];
  second.term_length--;
  narsil_field_tokens input[] = {fields[0], fields[1]};
  input[1].tokens.tokens = &second;
  narsil_index_terms_request request = {&data->segment, 0, input, FIELDS};
  check(narsil_index_terms(workspace, &request) == NARSIL_OK && data->terms.header[0] == FIELDS,
        "the removal refusal document has two distinct terms");
  void *before = malloc(sizeof *data);
  check(before != NULL, "the removal refusal comparison has memory");
  if (before != NULL) {
    uint32_t start = data->starts[1];
    data->starts[1] = POOL;
    memcpy(before, data, sizeof *data);
    check(narsil_remove_document(workspace, &request) == NARSIL_INVALID_ARGUMENT &&
              memcmp(before, (const void *)data, sizeof *data) == 0,
          "a corrupt later term cannot partially remove the document");
    data->starts[1] = start;
    data->fields[start] = FIELDS;
    memcpy(before, data, sizeof *data);
    check(narsil_remove_document(workspace, &request) == NARSIL_INVALID_ARGUMENT &&
              memcmp(before, (const void *)data, sizeof *data) == 0,
          "an invalid posting field preserves every removal region");
    data->fields[start] = 1;
    data->total_lengths[1] = 0;
    memcpy(before, data, sizeof *data);
    check(narsil_remove_document(workspace, &request) == NARSIL_INVALID_ARGUMENT &&
              memcmp(before, (const void *)data, sizeof *data) == 0,
          "a field total below its document length refuses removal atomically");
    free(before);
  }
  free(data);
}

static void expand_growing(narsil_workspace *workspace, segment_fixture *data) {
  enum { PREFIX_LENGTH = 2 };
  uint16_t text[] = {'h', 'a'};
  double expected = (double)PREFIX_LENGTH / (double)TERM_LENGTH;
  uint32_t segment = UINT32_MAX;
  uint32_t token = UINT32_MAX;
  double factor = -1;
  uint32_t count = UINT32_MAX;
  narsil_expansion_segment source = {.growing = &data->segment};
  narsil_prefix_request request = {&source, 1, text, 2, text, 2, text, 2};
  narsil_expansion_output output = {&segment, 1, &token, 1, &factor, 1};
  check(narsil_expand_prefix(workspace, &request, &output, &count) == NARSIL_OK && count == 1 && segment == 0 &&
            token == 0 && factor == expected,
        "prefix expansion reads the indexed surface and returns its token and factor");
  output.factor_capacity = 0;
  count = UINT32_MAX;
  check(narsil_expand_prefix(workspace, &request, &output, &count) == NARSIL_NEEDS_ROOM && count == UINT32_MAX &&
            segment == 0 && token == 0 && factor == expected,
        "a short prefix output preserves every output and count");
  output.factor_capacity = 1;
  output.tokens = data->frequencies;
  check(narsil_expand_prefix(workspace, &request, &output, &count) == NARSIL_INVALID_ARGUMENT &&
            data->frequencies[0] == 1 && count == UINT32_MAX,
        "prefix output cannot overwrite live keyword counts");
  output.tokens = &token;
  uint16_t original = data->surfaces.units[0];
  data->surfaces.units[0] = UINT16_C(0xd800);
  check(narsil_expand_prefix(workspace, &request, &output, &count) == NARSIL_OK && count == 0,
        "a malformed embedded surface is skipped without reading beyond it");
  data->surfaces.units[0] = original;
  text[0] = UINT16_C(0xd800);
  count = UINT32_MAX;
  check(narsil_expand_prefix(workspace, &request, &output, &count) == NARSIL_INVALID_ARGUMENT && count == UINT32_MAX,
        "a malformed query refuses before changing the output count");
}

static void suggest_growing(narsil_workspace *workspace, segment_fixture *data) {
  uint16_t text[] = {'h', 'a'};
  narsil_expansion_segment source = {.growing = &data->segment};
  narsil_suggestion_request request = {&source, 1, text, 2, text, 2, 1};
  uint32_t terms[NARSIL_SUGGESTION_WORDS] = {UINT32_MAX, UINT32_MAX, UINT32_MAX};
  uint32_t starts[2] = {UINT32_MAX, UINT32_MAX};
  uint32_t spellings[NARSIL_SUGGESTION_WORDS] = {UINT32_MAX, UINT32_MAX, UINT32_MAX};
  double occurrences = -1;
  uint32_t count = UINT32_MAX;
  narsil_suggestion_output output = {terms,     NARSIL_SUGGESTION_WORDS, starts,       2,
                                     spellings, NARSIL_SUGGESTION_WORDS, &occurrences, 1};
  check(narsil_suggest_terms(workspace, &request, &output, &count) == NARSIL_OK && count == 1 && terms[0] == 0 &&
            terms[1] == 0 && terms[2] == 1 && starts[0] == 0 && starts[1] == 1 && spellings[0] == 0 &&
            spellings[1] == NARSIL_SUGGESTION_SURFACE && spellings[2] == 0 && occurrences == 2,
        "suggestions retain the surface occurrence count and token document frequency");
  output.occurrence_capacity = 0;
  count = UINT32_MAX;
  check(narsil_suggest_terms(workspace, &request, &output, &count) == NARSIL_NEEDS_ROOM && count == UINT32_MAX &&
            terms[0] == 0 && terms[1] == 0 && terms[2] == 1 && starts[0] == 0 && starts[1] == 1 && spellings[0] == 0 &&
            spellings[1] == NARSIL_SUGGESTION_SURFACE && spellings[2] == 0 && occurrences == 2,
        "a short suggestion output preserves every output region");
  output.occurrence_capacity = 1;
  output.terms = data->surface_counts;
  check(narsil_suggest_terms(workspace, &request, &output, &count) == NARSIL_INVALID_ARGUMENT &&
            data->surface_counts[0] == 2 && count == UINT32_MAX,
        "suggestions refuse an output that overlaps live surface counts");
}

static void partial_growing(narsil_workspace *workspace, segment_fixture *data) {
  enum { QUERY_LENGTH = 3 };
  double expected = (double)QUERY_LENGTH / (double)SURFACE_LENGTH;
  uint16_t text[] = {'r', 'b', 'o'};
  narsil_expansion_segment source = {.growing = &data->segment};
  narsil_frozen_runs runs = {0};
  narsil_partial_word word = {text, 3, text, 3, 0, 0};
  narsil_partial_request request = {&source, &runs, 1, &word, 1};
  uint32_t starts[2] = {UINT32_MAX, UINT32_MAX};
  uint32_t segment = UINT32_MAX;
  uint32_t token = UINT32_MAX;
  double factor = -1;
  uint32_t count = UINT32_MAX;
  narsil_partial_output output = {{&segment, 1, &token, 1, &factor, 1}, starts, 2};
  check(narsil_expand_partial_words(workspace, &request, &output, &count) == NARSIL_OK && count == 1 &&
            starts[0] == 0 && starts[1] == 1 && segment == 0 && token == 0 && factor == expected,
        "partial expansion reads the spelling run and returns its token and factor");
  count = UINT32_MAX;
  output.additions.factor_capacity = 0;
  check(narsil_expand_partial_words(workspace, &request, &output, &count) == NARSIL_NEEDS_ROOM && count == UINT32_MAX &&
            starts[0] == 0 && starts[1] == 1 && segment == 0 && token == 0 && factor == expected,
        "a short partial output preserves the offsets, additions, and count");
  output.additions.factor_capacity = 1;
  output.starts = data->run_starts;
  uint32_t before = data->run_starts[0];
  check(narsil_expand_partial_words(workspace, &request, &output, &count) == NARSIL_INVALID_ARGUMENT &&
            data->run_starts[0] == before && count == UINT32_MAX,
        "partial output cannot overwrite the run spans that it reads");
  output.starts = starts;
  for (uint32_t at = 0; at < data->run_header[0]; at++) { data->run_starts[at] = UINT32_MAX; }
  check(narsil_expand_partial_words(workspace, &request, &output, &count) == NARSIL_OK && count == 0 &&
            starts[0] == 0 && starts[1] == 0,
        "partial expansion skips an embedded run span outside its member region");
}

static void merge_growing(narsil_workspace *workspace, segment_fixture *data) {
  uint32_t mapping[] = {0};
  uint16_t fields[] = {1, 0};
  const uint32_t *lengths[] = {data->field_lengths, data->field_lengths + ORDINALS};
  narsil_keyword_merge_input input = {.mapping = mapping,
                                      .field_mapping = fields,
                                      .field_lengths = lengths,
                                      .document_count = 1,
                                      .field_count = FIELDS,
                                      .growing = &data->segment};
  narsil_keyword_merge_request request = {&input, 1, 1, FIELDS, NULL};
  narsil_keyword_merge_sizes sizes = {0};
  check(narsil_measure_merge(workspace, &request, &sizes) == NARSIL_OK && sizes.terms == 1 &&
            sizes.term_bytes == TERM_LENGTH && sizes.postings == FIELDS && sizes.positions == FIELDS,
        "a growing merge measures the indexed fields and positions directly");
  uint8_t text[TERM_LENGTH] = {0};
  uint32_t offsets[2] = {0};
  uint32_t counts[1] = {0};
  uint32_t posting_offsets[2] = {0};
  uint32_t documents[FIELDS] = {0};
  uint16_t frequencies[FIELDS] = {0};
  uint16_t field_values[FIELDS] = {0};
  uint32_t position_offsets[FIELDS + 1] = {0};
  uint32_t positions[FIELDS] = {0};
  uint32_t field_lengths[FIELDS] = {0};
  double totals[FIELDS] = {0};
  uint32_t surface_offsets[1] = {0};
  uint32_t spelling_offsets[1] = {0};
  narsil_keyword_merge_output output = {.terms = {text, offsets, counts, 1, TERM_LENGTH, 2},
                                        .posting_offsets = posting_offsets,
                                        .posting_offset_capacity = 2,
                                        .posting_documents = documents,
                                        .posting_frequencies = frequencies,
                                        .posting_fields = field_values,
                                        .posting_capacity = FIELDS,
                                        .position_offsets = position_offsets,
                                        .position_offset_capacity = FIELDS + 1,
                                        .position_values = positions,
                                        .position_capacity = FIELDS,
                                        .field_lengths = field_lengths,
                                        .field_length_capacity = FIELDS,
                                        .total_field_lengths = totals,
                                        .field_count = FIELDS,
                                        .surfaces = {.offsets = surface_offsets, .offset_capacity = 1},
                                        .spellings = {.offsets = spelling_offsets, .offset_capacity = 1}};
  check(narsil_write_merge(workspace, &request, &output) == NARSIL_OK && memcmp(text, "harbor", TERM_LENGTH) == 0 &&
            counts[0] == 1 && posting_offsets[1] == FIELDS && frequencies[0] == 1 && frequencies[1] == 1 &&
            field_values[0] == 1 && field_values[1] == 0 && position_offsets[FIELDS] == FIELDS &&
            field_lengths[0] == 1 && field_lengths[1] == 1,
        "a growing merge preserves field order, frequencies, positions, and lengths");
  uint32_t start = data->starts[0];
  uint32_t position_start = data->positions_at[start];
  data->positions_at[start] = UINT32_MAX;
  check(narsil_write_merge(workspace, &request, &output) == NARSIL_OK && counts[0] == 1 &&
            memcmp(text, "harbor", TERM_LENGTH) == 0 && position_offsets[FIELDS] == FIELDS - 1,
        "a growing merge skips an out-of-region position while retaining its posting");
  data->positions_at[start] = position_start;
}

void segment_write_checks(narsil_workspace *workspace) {
  uint16_t units[] = {'h', 'a', 'r', 'b', 'o', 'r', 'h', 'a', 'r', 'b', 'o', 'r', 's'};
  narsil_token token = {0, 0, TERM_LENGTH, TERM_LENGTH, SURFACE_LENGTH, 0, 0, NARSIL_NO_TERM_SLOT};
  narsil_field_tokens fields[] = {{0, {&token, 1, units, sizeof units / sizeof units[0]}},
                                  {1, {&token, 1, units, sizeof units / sizeof units[0]}}};
  segment_fixture *data = create_segment();
  check(data != NULL, "the growing segment fixture has memory");
  if (data == NULL) { return; }
  narsil_index_terms_request request = {&data->segment, 0, fields, FIELDS};
  check(narsil_index_terms(workspace, &request) == NARSIL_OK, "one operation indexes both text fields");
  check(data->documents == 1 && data->terms.header[0] == 1 && data->frequencies[0] == 1 && data->lengths[0] == 2 &&
            data->occurrences[0] == 2 && data->surface_counts[0] == 2 && data->spelling_counts[0] == 2 &&
            data->field_lengths[0] == 1 && data->field_lengths[ORDINALS] == 1 && data->run_header[0] == SURFACE_RUNS,
        "postings, counts, field lengths, and distinct spelling runs describe the same document");
  uint32_t start = data->starts[0];
  check(data->docs[start] == 0 && data->docs[start + 1] == 0 && data->fields[start] == 0 &&
            data->fields[start + 1] == 1,
        "one document's token postings remain adjacent in ascending field order");
  merge_growing(workspace, data);
  expand_growing(workspace, data);
  suggest_growing(workspace, data);
  count_boundaries(workspace, data, request);
  partial_growing(workspace, data);
  free(data);
  short_regions(workspace, fields);
  removal_counts(workspace, fields);
  batch_refusals(workspace);
  compact_dictionary(workspace);
  posting_refusals(workspace, fields);
  removal_refusals(workspace, fields);
  segment_merge_checks(workspace);
}
