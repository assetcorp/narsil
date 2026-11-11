#include "fixture.h"

#include "../include/narsil_core.h"
#include "../include/narsil_frozen_segments.h"
#include "../include/narsil_posting_merge.h"
#include "../include/narsil_segment_merge.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

enum { MERGE_TEXT_BYTES = 32, MERGE_ENTRIES = 16, MERGE_FIELDS = 2, MERGE_SENTINEL = 73 };
enum { MERGE_TERM_BYTES = 6, MERGE_SURFACE_BYTES = 7, MERGE_PAIR_BYTES = 13, MERGE_POSTINGS = 5 };
static const double MERGED_FIELD_LENGTH = 7;
static const double MERGED_FREQUENCY = 9;

typedef struct {
  uint8_t text[MERGE_TEXT_BYTES];
  uint32_t offsets[MERGE_ENTRIES];
  uint32_t counts[MERGE_ENTRIES];
} merged_strings_fixture;

typedef struct {
  merged_strings_fixture terms;
  merged_strings_fixture surfaces;
  merged_strings_fixture spellings;
  uint32_t posting_offsets[MERGE_ENTRIES];
  uint32_t documents[MERGE_ENTRIES];
  uint16_t frequencies[MERGE_ENTRIES];
  uint16_t fields[MERGE_ENTRIES];
  uint32_t position_offsets[MERGE_ENTRIES];
  uint32_t positions[MERGE_ENTRIES];
  uint32_t lengths[MERGE_ENTRIES];
  double totals[MERGE_FIELDS];
} merge_fixture;

static narsil_merged_strings output_strings(merged_strings_fixture *data) {
  return (narsil_merged_strings){data->text,    data->offsets,    data->counts,
                                 MERGE_ENTRIES, MERGE_TEXT_BYTES, MERGE_ENTRIES};
}

static narsil_keyword_merge_output output_of(merge_fixture *data) {
  return (narsil_keyword_merge_output){output_strings(&data->terms),
                                       data->posting_offsets,
                                       MERGE_ENTRIES,
                                       data->documents,
                                       data->frequencies,
                                       data->fields,
                                       MERGE_ENTRIES,
                                       data->position_offsets,
                                       MERGE_ENTRIES,
                                       data->positions,
                                       MERGE_ENTRIES,
                                       data->lengths,
                                       MERGE_ENTRIES,
                                       data->totals,
                                       MERGE_FIELDS,
                                       output_strings(&data->surfaces),
                                       output_strings(&data->spellings)};
}

static int same_strings(const merged_strings_fixture *first, const merged_strings_fixture *second) {
  return memcmp(first->text, second->text, sizeof first->text) == 0 &&
         memcmp(first->offsets, second->offsets, sizeof first->offsets) == 0 &&
         memcmp(first->counts, second->counts, sizeof first->counts) == 0;
}

static int unchanged(const merge_fixture *first, const merge_fixture *second) {
  return same_strings(&first->terms, &second->terms) && same_strings(&first->surfaces, &second->surfaces) &&
         same_strings(&first->spellings, &second->spellings) &&
         memcmp(first->posting_offsets, second->posting_offsets, sizeof first->posting_offsets) == 0 &&
         memcmp(first->documents, second->documents, sizeof first->documents) == 0 &&
         memcmp(first->frequencies, second->frequencies, sizeof first->frequencies) == 0 &&
         memcmp(first->fields, second->fields, sizeof first->fields) == 0 &&
         memcmp(first->position_offsets, second->position_offsets, sizeof first->position_offsets) == 0 &&
         memcmp(first->positions, second->positions, sizeof first->positions) == 0 &&
         memcmp(first->lengths, second->lengths, sizeof first->lengths) == 0 && first->totals[0] == second->totals[0] &&
         first->totals[1] == second->totals[1];
}

static int same_sizes(narsil_keyword_merge_sizes first, narsil_keyword_merge_sizes second) {
  return first.terms == second.terms && first.term_bytes == second.term_bytes && first.postings == second.postings &&
         first.positions == second.positions && first.has_positions == second.has_positions &&
         first.surfaces == second.surfaces && first.surface_bytes == second.surface_bytes &&
         first.spellings == second.spellings && first.spelling_bytes == second.spelling_bytes;
}

static void posting_merge_checks(narsil_workspace *workspace, narsil_keyword_merge_request *request) {
  merge_fixture data = {0};
  data.documents[0] = MERGE_SENTINEL;
  data.positions[0] = MERGE_SENTINEL;
  data.totals[0] = MERGE_SENTINEL;
  merge_fixture before = data;
  uint32_t count = MERGE_SENTINEL;
  narsil_posting_merge_output output = {data.documents,        data.frequencies, data.fields,    MERGE_POSTINGS - 1,
                                        data.position_offsets, MERGE_ENTRIES,    data.positions, MERGE_ENTRIES,
                                        data.totals,           MERGE_FIELDS};
  check(narsil_merge_postings(workspace, request, &output, &count) == NARSIL_NEEDS_ROOM && count == MERGE_SENTINEL &&
            unchanged(&data, &before),
        "a short paged posting output leaves every region and its count unchanged");
  output.row_capacity = MERGE_ENTRIES;
  check(narsil_merge_postings(workspace, request, &output, &count) == NARSIL_OK && count == MERGE_POSTINGS &&
            data.documents[0] == 0 && data.documents[1] == 1 && data.documents[2] == 1 && data.documents[3] == 2 &&
            data.documents[4] == 2 && data.fields[1] == 0 && data.fields[2] == 1 && data.frequencies[1] == 2 &&
            data.frequencies[2] == 1 && data.position_offsets[MERGE_POSTINGS] == MERGE_POSTINGS &&
            data.positions[1] == 1 && data.positions[2] == 2 && data.totals[0] == 3 &&
            data.totals[1] == MERGED_FREQUENCY,
        "paged postings retain frequencies and positions while ordering remapped fields");
  before = data;
  output.positions = data.documents;
  check(narsil_merge_postings(workspace, request, &output, &count) == NARSIL_INVALID_ARGUMENT &&
            unchanged(&data, &before),
        "paged postings refuse overlapping output regions");
  output.positions = data.positions;
  const uint32_t *prior = request->inputs[0].posting_documents;
  narsil_keyword_merge_input malformed = request->inputs[0];
  malformed.posting_documents = NULL;
  narsil_keyword_merge_request invalid = {&malformed, 1, request->document_count, request->field_count, NULL};
  check(narsil_merge_postings(workspace, &invalid, &output, &count) == NARSIL_INVALID_ARGUMENT &&
            unchanged(&data, &before) && request->inputs[0].posting_documents == prior,
        "paged postings refuse a missing live input region before dereferencing it");
}

static void retained_merge_checks(narsil_workspace *workspace, const narsil_keyword_merge_request *source) {
  uint32_t zero = 0;
  narsil_keyword_merge_input inputs[2];
  for (size_t at = 0; at < 2; at++) {
    inputs[at] = source->inputs[at];
    inputs[at].terms = (narsil_frozen_strings){NULL, 0, &zero, NULL, 0};
    inputs[at].payload_slots = NULL;
    inputs[at].posting_offsets = &zero;
    inputs[at].posting_documents = NULL;
    inputs[at].posting_frequencies = NULL;
    inputs[at].posting_fields = NULL;
    inputs[at].posting_count = 0;
    inputs[at].position_offsets = NULL;
    inputs[at].position_values = NULL;
    inputs[at].position_count = 0;
  }
  narsil_keyword_merge_request request = {inputs, 2, source->document_count, source->field_count,
                                          &source->inputs[0].terms};
  merge_fixture data = {0};
  data.documents[0] = MERGE_SENTINEL;
  narsil_keyword_merge_output output = output_of(&data);
  narsil_keyword_merge_sizes sizes = {0};
  check(narsil_measure_merge(workspace, &request, &sizes) == NARSIL_OK && sizes.postings == 0 && sizes.spellings == 1 &&
            narsil_write_merge(workspace, &request, &output) == NARSIL_OK && data.documents[0] == MERGE_SENTINEL &&
            data.terms.counts[0] == source->inputs[0].terms.counts[0] && data.surfaces.counts[0] == UINT32_MAX &&
            data.spellings.counts[0] == 3 && data.totals[0] == MERGED_FIELD_LENGTH,
        "paged metadata merges fields and spellings without republishing postings");
  merge_fixture before = data;
  uint8_t retained_text[MERGE_TERM_BYTES];
  memcpy(retained_text, request.retained_terms->text, sizeof retained_text);
  narsil_frozen_strings retained = *request.retained_terms;
  retained.text = retained_text;
  request.retained_terms = &retained;
  output.terms.text = retained_text;
  output.terms.text_capacity = request.retained_terms->text_bytes;
  check(narsil_write_merge(workspace, &request, &output) == NARSIL_INVALID_ARGUMENT && unchanged(&data, &before),
        "paged metadata refuses output overlap with the retained term table");
}

void segment_merge_checks(narsil_workspace *workspace) {
  const uint8_t term_text[] = "harbor";
  const uint8_t pair_text[] = "harborsharbor";
  uint32_t term_offsets[] = {0, MERGE_TERM_BYTES};
  uint32_t pair_offsets[] = {0, MERGE_SURFACE_BYTES, MERGE_PAIR_BYTES};
  uint32_t term_counts[] = {2};
  uint32_t first_surface[] = {UINT32_MAX - 1};
  uint32_t second_surface[] = {1};
  uint32_t first_spelling[] = {2};
  uint32_t second_spelling[] = {1};
  narsil_frozen_strings surfaces[] = {{pair_text, MERGE_PAIR_BYTES, pair_offsets, first_surface, 1},
                                      {pair_text, MERGE_PAIR_BYTES, pair_offsets, second_surface, 1}};
  narsil_frozen_strings spellings[] = {{pair_text, MERGE_PAIR_BYTES, pair_offsets, first_spelling, 1},
                                       {pair_text, MERGE_PAIR_BYTES, pair_offsets, second_spelling, 1}};
  uint32_t slots[] = {0};
  uint32_t posting_offsets[] = {0, 3};
  uint32_t documents[] = {0, 0, 1};
  uint16_t frequencies[] = {1, 2, 3};
  uint16_t fields[] = {0, 1, 0};
  uint32_t position_offsets[] = {0, 1, 2, 3};
  uint32_t positions[] = {2, 1, 0};
  uint32_t mappings[][2] = {{2, 0}, {1, UINT32_MAX}};
  uint16_t field_mappings[][MERGE_FIELDS] = {{0, 1}, {1, 0}};
  uint32_t lengths[] = {3, 1};
  const uint32_t *field_lengths[] = {lengths, lengths};
  narsil_keyword_merge_input inputs[2];
  for (size_t at = 0; at < 2; at++) {
    inputs[at] = (narsil_keyword_merge_input){{term_text, MERGE_TERM_BYTES, term_offsets, term_counts, 1},
                                              slots,
                                              posting_offsets,
                                              documents,
                                              frequencies,
                                              fields,
                                              3,
                                              position_offsets,
                                              positions,
                                              3,
                                              mappings[at],
                                              field_mappings[at],
                                              field_lengths,
                                              2,
                                              MERGE_FIELDS,
                                              surfaces + at,
                                              spellings + at,
                                              NULL};
  }
  narsil_keyword_merge_request request = {inputs, 2, 3, MERGE_FIELDS, NULL};
  posting_merge_checks(workspace, &request);
  retained_merge_checks(workspace, &request);
  narsil_keyword_merge_sizes sizes = {0};
  check(narsil_measure_merge(workspace, &request, &sizes) == NARSIL_OK && sizes.terms == 1 &&
            sizes.term_bytes == MERGE_TERM_BYTES && sizes.postings == MERGE_POSTINGS &&
            sizes.positions == MERGE_POSTINGS && sizes.has_positions == 1 && sizes.surfaces == 1 &&
            sizes.surface_bytes == MERGE_PAIR_BYTES && sizes.spellings == 1 && sizes.spelling_bytes == MERGE_PAIR_BYTES,
        "merge measurement includes every kept posting, position, surface, and spelling");
  merge_fixture data = {0};
  data.terms.offsets[0] = MERGE_SENTINEL;
  data.documents[0] = MERGE_SENTINEL;
  data.totals[0] = MERGE_SENTINEL;
  narsil_keyword_merge_output output = output_of(&data);
  merge_fixture before = data;
  output.posting_capacity = MERGE_POSTINGS - 1;
  check(narsil_write_merge(workspace, &request, &output) == NARSIL_NEEDS_ROOM && unchanged(&data, &before),
        "a short merge posting output leaves every region unchanged");
  output = output_of(&data);
  check(narsil_write_merge(workspace, &request, &output) == NARSIL_OK && data.terms.counts[0] == 3 &&
            data.documents[0] == 0 && data.documents[1] == 1 && data.documents[2] == 1 && data.documents[3] == 2 &&
            data.documents[4] == 2 && data.frequencies[0] == 3 && data.fields[1] == 1 && data.fields[2] == 0 &&
            data.positions[0] == 0 && data.positions[1] == 2 && data.positions[2] == 1 &&
            data.surfaces.counts[0] == UINT32_MAX && data.spellings.counts[0] == 3 && data.lengths[0] == 1 &&
            data.lengths[1] == 3 && data.lengths[2] == 3 && data.totals[0] == MERGED_FIELD_LENGTH &&
            data.totals[1] == MERGED_FIELD_LENGTH,
        "merge preserves per-document field order and positions through nonmonotonic ordinal remapping");
  before = data;
  narsil_keyword_merge_sizes prior_sizes = sizes;
  second_surface[0] = 2;
  check(narsil_measure_merge(workspace, &request, &sizes) == NARSIL_SEGMENT_FULL && same_sizes(sizes, prior_sizes) &&
            narsil_write_merge(workspace, &request, &output) == NARSIL_SEGMENT_FULL && unchanged(&data, &before),
        "UINT32_MAX plus one surface occurrences refuses measurement and publication atomically");
  second_surface[0] = 1;
  first_spelling[0] = UINT32_MAX;
  check(narsil_measure_merge(workspace, &request, &sizes) == NARSIL_SEGMENT_FULL && same_sizes(sizes, prior_sizes) &&
            narsil_write_merge(workspace, &request, &output) == NARSIL_SEGMENT_FULL && unchanged(&data, &before),
        "UINT32_MAX plus one spelling occurrences refuses measurement and publication atomically");
  first_spelling[0] = 2;
  output.position_values = data.documents;
  check(narsil_write_merge(workspace, &request, &output) == NARSIL_INVALID_ARGUMENT && unchanged(&data, &before),
        "merge outputs cannot overwrite each other");
  output = output_of(&data);
  output.terms.text = (uint8_t *)mappings;
  output.terms.text_capacity = sizeof mappings;
  check(narsil_write_merge(workspace, &request, &output) == NARSIL_INVALID_ARGUMENT && mappings[0][0] == 2 &&
            unchanged(&data, &before),
        "merge outputs cannot overwrite a live source mapping");
  output = output_of(&data);
  mappings[1][0] = 0;
  check(narsil_write_merge(workspace, &request, &output) == NARSIL_INVALID_ARGUMENT && unchanged(&data, &before),
        "merge refuses duplicate target ordinals before writing");
  mappings[1][0] = 1;
  documents[2] = UINT32_MAX;
  check(narsil_measure_merge(workspace, &request, &sizes) == NARSIL_OK && sizes.postings == 4,
        "merge skips a corrupt embedded document ordinal");
}
