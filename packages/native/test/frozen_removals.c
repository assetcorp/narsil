#include "allocation_failures.h"
#include "fixture.h"

#include "../include/narsil_analysis.h"
#include "../include/narsil_core.h"
#include "../include/narsil_expansion.h"
#include "../include/narsil_frozen_segments.h"
#include "../include/narsil_segments.h"
#include "../include/narsil_suggestions.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

enum {
  HARBOR_LENGTH = 6,
  HARBORS_LENGTH = 7,
  FIELD_COUNT = 2,
  DOCUMENTS = 3,
  PENDING_DOCUMENTS = 4,
  PENDING_TOKENS = 8,
  PENDING_UNITS = 64,
  TOKEN_UNITS = HARBOR_LENGTH + HARBORS_LENGTH,
  DOCUMENT_UNITS = FIELD_COUNT * TOKEN_UNITS,
  PREPARED_REPLACEMENTS = 5,
  PENDING_HEADER_COUNTS = NARSIL_PENDING_UNITS + 1,
  PREPARED_ORDINAL = 2
};

enum { TOMBSTONE_KIND = 4, TOMBSTONE_COUNT_KIND = 5, PENDING_HEADER_KIND = 6 };

static const uint8_t TERM_TEXT[] = "harbor";
static const uint32_t TERM_OFFSETS[] = {0, HARBOR_LENGTH};
static const uint32_t TERM_COUNTS[] = {2};
static const uint32_t SLOTS[] = {0};
static const uint32_t POSTING_OFFSETS[] = {0, 3};
static const uint32_t POSTING_DOCUMENTS[] = {0, 0, 1};
static const uint16_t POSTING_FREQUENCIES[] = {1, 1, 1};
static const uint16_t POSTING_FIELDS[] = {0, 1, 0};
static const uint8_t SURFACE_TEXT[] = "harborsharbor";
static const uint32_t SURFACE_OFFSETS[] = {0, HARBORS_LENGTH, TOKEN_UNITS};
static const uint32_t SURFACE_COUNTS[] = {3};
static const uint8_t SPELLING_TEXT[] = "harbors";
static const uint32_t SPELLING_OFFSETS[] = {0, HARBORS_LENGTH};
static const uint32_t SPELLING_COUNTS[] = {2};
static const uint8_t PARTIAL_FIELDS[] = {1, 0};
static const uint32_t INDEX_STARTS[] = {0, 2, 3, 3};
static const uint32_t INDEX_ROWS[] = {0, 1, 2};

typedef struct {
  narsil_frozen_strings surfaces;
  narsil_frozen_strings spellings;
  narsil_frozen_removal_index index;
  narsil_frozen_segment segment;
} segment_fixture;

typedef struct {
  uint32_t bits;
  uint32_t count;
  uint32_t documents;
  double occurrences;
  uint32_t surfaces;
  uint32_t spellings;
  uint32_t header[NARSIL_PENDING_HEADER_WORDS];
  uint32_t pending[PENDING_DOCUMENTS];
  uint32_t tokens[PENDING_TOKENS * NARSIL_PENDING_TOKEN_WORDS];
  uint16_t units[PENDING_UNITS];
} state_fixture;

typedef struct {
  uint32_t kind;
  uint32_t entry;
  double value;
} prepared_replacement;

static void build_segment(segment_fixture *fixture, int indexed) {
  fixture->surfaces =
      (narsil_frozen_strings){SURFACE_TEXT, sizeof SURFACE_TEXT - 1, SURFACE_OFFSETS, SURFACE_COUNTS, 1};
  fixture->spellings =
      (narsil_frozen_strings){SPELLING_TEXT, sizeof SPELLING_TEXT - 1, SPELLING_OFFSETS, SPELLING_COUNTS, 1};
  fixture->index = (narsil_frozen_removal_index){INDEX_STARTS, INDEX_ROWS, SLOTS};
  fixture->segment = (narsil_frozen_segment){.terms = {TERM_TEXT, sizeof TERM_TEXT - 1, TERM_OFFSETS, TERM_COUNTS, 1},
                                             .payload_slots = SLOTS,
                                             .posting_offsets = POSTING_OFFSETS,
                                             .posting_documents = POSTING_DOCUMENTS,
                                             .posting_frequencies = POSTING_FREQUENCIES,
                                             .posting_fields = POSTING_FIELDS,
                                             .posting_count = 3,
                                             .surfaces = &fixture->surfaces,
                                             .spellings = &fixture->spellings,
                                             .spelling_tokens = SLOTS,
                                             .removal_index = indexed ? &fixture->index : NULL,
                                             .partial_fields = PARTIAL_FIELDS,
                                             .field_count = FIELD_COUNT,
                                             .document_count = DOCUMENTS};
}

static narsil_frozen_segment_state state_of(state_fixture *fixture, size_t documents, size_t tokens) {
  return (narsil_frozen_segment_state){.tombstones = &fixture->bits,
                                       .tombstone_count = &fixture->count,
                                       .removed_documents = &fixture->documents,
                                       .removed_occurrences = &fixture->occurrences,
                                       .removed_surfaces = &fixture->surfaces,
                                       .removed_spellings = &fixture->spellings,
                                       .pending_header = fixture->header,
                                       .pending_documents = fixture->pending,
                                       .pending_document_capacity = documents,
                                       .pending_tokens = fixture->tokens,
                                       .pending_token_capacity = tokens,
                                       .pending_units = fixture->units,
                                       .pending_unit_capacity = PENDING_UNITS};
}

static int counts_equal(const state_fixture *left, const state_fixture *right) {
  return left->bits == right->bits && left->count == right->count && left->documents == right->documents &&
         left->occurrences == right->occurrences && left->surfaces == right->surfaces &&
         left->spellings == right->spellings &&
         memcmp(left->header, right->header, PENDING_HEADER_COUNTS * sizeof *left->header) == 0;
}

static int states_equal(const state_fixture *left, const state_fixture *right) {
  return counts_equal(left, right) && memcmp(left->header, right->header, sizeof left->header) == 0 &&
         memcmp(left->pending, right->pending, sizeof left->pending) == 0 &&
         memcmp(left->tokens, right->tokens, sizeof left->tokens) == 0 &&
         memcmp(left->units, right->units, sizeof left->units) == 0;
}

static int prepared_is(const uint32_t *entries, const double *values, size_t position, prepared_replacement expected) {
  return entries[position * 2] == expected.kind && entries[(position * 2) + 1] == expected.entry &&
         values[position] == expected.value;
}

static narsil_status remove_ordinal(narsil_workspace *workspace, narsil_remove_frozen_request request,
                                    uint32_t ordinal) {
  request.ordinal = ordinal;
  return narsil_remove_frozen_document(workspace, &request);
}

static void prepared_removals(narsil_workspace *workspace, narsil_remove_frozen_request request, state_fixture *state) {
  uint32_t entries[PREPARED_REPLACEMENTS * 2] = {0};
  double values[PREPARED_REPLACEMENTS] = {0};
  size_t written = SIZE_MAX;
  narsil_frozen_removal_output output = {entries, values, PREPARED_REPLACEMENTS - 1, PREPARED_REPLACEMENTS};
  state_fixture before = *state;
  request.ordinal = PREPARED_ORDINAL;
  check(narsil_prepare_frozen_removal(workspace, &request, &output, &written) == NARSIL_NEEDS_ROOM &&
            written == SIZE_MAX && states_equal(&before, state) && entries[0] == 0,
        "frozen preparation refuses a short output without changing a region");
  output.entry_capacity = PREPARED_REPLACEMENTS;
  check(narsil_prepare_frozen_removal(workspace, &request, &output, &written) == NARSIL_OK &&
            written == PREPARED_REPLACEMENTS && counts_equal(&before, state) &&
            prepared_is(entries, values, 0, (prepared_replacement){TOMBSTONE_KIND, 0, 1U << PREPARED_ORDINAL}) &&
            prepared_is(entries, values, 1, (prepared_replacement){TOMBSTONE_COUNT_KIND, 0, 1}) &&
            prepared_is(entries, values, 2, (prepared_replacement){PENDING_HEADER_KIND, NARSIL_PENDING_DOCUMENTS, 1}) &&
            prepared_is(entries, values, 3,
                        (prepared_replacement){PENDING_HEADER_KIND, NARSIL_PENDING_TOKENS, FIELD_COUNT}) &&
            prepared_is(entries, values, 4,
                        (prepared_replacement){PENDING_HEADER_KIND, NARSIL_PENDING_UNITS, DOCUMENT_UNITS}) &&
            state->pending[0] == PREPARED_ORDINAL,
        "frozen preparation returns the tombstone and pending header words and leaves the published counts alone");
  output.entries = &state->bits;
  output.entry_capacity = 0;
  output.values = &state->occurrences;
  output.value_capacity = 1;
  written = SIZE_MAX;
  check(narsil_prepare_frozen_removal(workspace, &request, &output, &written) == NARSIL_INVALID_ARGUMENT &&
            written == SIZE_MAX && counts_equal(&before, state),
        "prepared frozen output cannot overlap the live removal state");
}

static void deferred_counts(narsil_workspace *workspace, narsil_remove_frozen_request request, state_fixture *state) {
  narsil_frozen_segment_state *view = request.state;
  check(remove_ordinal(workspace, request, 0) == NARSIL_OK && state->bits == 1 && state->count == 1 &&
            state->documents == 0 && state->occurrences == 0 && state->surfaces == 0 && state->spellings == 0 &&
            state->header[NARSIL_PENDING_DOCUMENTS] == 1 && state->header[NARSIL_PENDING_TOKENS] == FIELD_COUNT &&
            state->header[NARSIL_PENDING_UNITS] == DOCUMENT_UNITS && state->pending[0] == 0,
        "frozen removal marks the tombstone and defers every removed count");
  state_fixture before = *state;
  check(remove_ordinal(workspace, request, 0) == NARSIL_OK && states_equal(&before, state),
        "removing a tombstoned document leaves the state unchanged");
  uint32_t entry = UINT32_MAX;
  uint32_t token = UINT32_MAX;
  double factor = -1;
  uint32_t count = UINT32_MAX;
  uint16_t prefix[] = {'h', 'a'};
  narsil_expansion_segment source = {.frozen = request.segment, .state = view};
  narsil_prefix_request expansion = {&source, 1, prefix, 2, prefix, 2, prefix, 2};
  narsil_expansion_output output = {&entry, 1, &token, 1, &factor, 1};
  check(narsil_expand_prefix(workspace, &expansion, &output, &count) == NARSIL_INVALID_ARGUMENT && count == UINT32_MAX,
        "a read refuses a state that holds pending removals");
  check(narsil_settle_frozen_state(workspace, request.segment, view, NULL) == NARSIL_OK && state->documents == 1 &&
            state->occurrences == 2 && state->surfaces == 2 && state->spellings == 1 &&
            state->header[NARSIL_PENDING_DOCUMENTS] == 0 && state->header[NARSIL_PENDING_TOKENS] == 0 &&
            state->header[NARSIL_PENDING_UNITS] == 0,
        "settling applies term and spelling counts once across fields");
  before = *state;
  check(narsil_settle_frozen_state(workspace, request.segment, view, NULL) == NARSIL_OK && states_equal(&before, state),
        "settling a settled state changes nothing");
}

static void order_independence(narsil_workspace *workspace, narsil_remove_frozen_request request, int indexed) {
  segment_fixture segment;
  build_segment(&segment, indexed);
  state_fixture together = {0};
  state_fixture apart = {0};
  narsil_frozen_segment_state first = state_of(&together, PENDING_DOCUMENTS, PENDING_TOKENS);
  narsil_frozen_segment_state second = state_of(&apart, PENDING_DOCUMENTS, PENDING_TOKENS);
  request.segment = &segment.segment;
  request.state = &first;
  int removed = remove_ordinal(workspace, request, 0) == NARSIL_OK &&
                remove_ordinal(workspace, request, 1) == NARSIL_OK &&
                narsil_settle_frozen_state(workspace, &segment.segment, &first, NULL) == NARSIL_OK;
  request.state = &second;
  removed = removed && remove_ordinal(workspace, request, 1) == NARSIL_OK &&
            narsil_settle_frozen_state(workspace, &segment.segment, &second, NULL) == NARSIL_OK &&
            remove_ordinal(workspace, request, 0) == NARSIL_OK &&
            narsil_settle_frozen_state(workspace, &segment.segment, &second, NULL) == NARSIL_OK;
  check(removed && counts_equal(&together, &apart) && together.documents == 2 && together.occurrences == 3 &&
            together.surfaces == 3 && together.spellings == 2 && together.count == 2,
        indexed ? "settling through the removal index matches removals one at a time in any order"
                : "settling through a posting scan matches removals one at a time in any order");
}

static void full_regions(narsil_workspace *workspace, narsil_remove_frozen_request request) {
  state_fixture small = {0};
  narsil_frozen_segment_state view = state_of(&small, 2, (size_t)FIELD_COUNT * 2);
  request.state = &view;
  check(remove_ordinal(workspace, request, 0) == NARSIL_OK && remove_ordinal(workspace, request, 1) == NARSIL_OK &&
            small.header[NARSIL_PENDING_DOCUMENTS] == 2 && small.documents == 0,
        "the pending regions hold removals until they fill");
  check(remove_ordinal(workspace, request, 2) == NARSIL_OK && small.documents == 2 && small.occurrences == 3 &&
            small.header[NARSIL_PENDING_DOCUMENTS] == 1 && small.pending[0] == 2 && small.count == DOCUMENTS,
        "a removal into full pending regions settles them first and then appends");
  state_fixture narrow = {0};
  view = state_of(&narrow, PENDING_DOCUMENTS, 1);
  check(remove_ordinal(workspace, request, 0) == NARSIL_NEEDS_ROOM && narrow.bits == 0 && narrow.count == 0 &&
            narrow.header[NARSIL_PENDING_DOCUMENTS] == 0,
        "a document too large for empty pending regions needs room before any change");
  view.pending_token_capacity = PENDING_TOKENS;
  check(remove_ordinal(workspace, request, 1) == NARSIL_OK, "a narrow state accepts a removal once it grows");
  state_fixture held = narrow;
  view.pending_token_capacity = FIELD_COUNT;
  narsil_token doubled[] = {request.fields[0].tokens.tokens[0], request.fields[0].tokens.tokens[0]};
  narsil_field_tokens larger[] = {request.fields[0], request.fields[1]};
  larger[0].tokens.tokens = doubled;
  larger[0].tokens.token_count = 2;
  request.fields = larger;
  check(remove_ordinal(workspace, request, 0) == NARSIL_NEEDS_ROOM && states_equal(&held, &narrow),
        "needing room leaves pending removals unsettled");
}

static void refused_states(narsil_workspace *workspace, narsil_remove_frozen_request request, state_fixture *state) {
  narsil_frozen_segment_state *view = request.state;
  memset(state, 0, sizeof *state);
  check(remove_ordinal(workspace, request, 1) == NARSIL_OK, "a fresh state accepts a removal");
  state_fixture before = *state;
  state->pending[0] = 2;
  check(narsil_settle_frozen_state(workspace, request.segment, view, NULL) == NARSIL_INVALID_ARGUMENT &&
            state->documents == 0 && state->header[NARSIL_PENDING_DOCUMENTS] == 1,
        "settling refuses a pending ordinal that holds no tombstone");
  state->pending[0] = 1;
  state->pending[1] = 1;
  state->header[NARSIL_PENDING_DOCUMENTS] = 2;
  check(narsil_settle_frozen_state(workspace, request.segment, view, NULL) == NARSIL_INVALID_ARGUMENT &&
            state->documents == 0,
        "settling refuses a document listed twice");
  *state = before;
  state->tokens[1] = PENDING_UNITS;
  check(narsil_settle_frozen_state(workspace, request.segment, view, NULL) == NARSIL_INVALID_ARGUMENT &&
            state->documents == 0 && state->surfaces == 0,
        "settling refuses a pending token outside the pending units");
  *state = before;
  state->header[NARSIL_PENDING_TOKENS] = PENDING_TOKENS + 1;
  check(narsil_settle_frozen_state(workspace, request.segment, view, NULL) == NARSIL_INVALID_ARGUMENT,
        "settling refuses a pending count above its region");
  *state = before;
  view->removed_surfaces = view->removed_documents;
  check(remove_ordinal(workspace, request, 0) == NARSIL_INVALID_ARGUMENT && states_equal(&before, state),
        "frozen removal refuses overlapping state before writes");
  view->removed_surfaces = &state->surfaces;
  view->pending_documents = &state->bits;
  check(remove_ordinal(workspace, request, 0) == NARSIL_INVALID_ARGUMENT && states_equal(&before, state),
        "frozen removal refuses pending regions that overlap the tombstones");
  view->pending_documents = state->pending;
  request.ordinal = DOCUMENTS;
  check(narsil_remove_frozen_document(workspace, &request) == NARSIL_INVALID_ARGUMENT && states_equal(&before, state),
        "frozen removal refuses an ordinal outside its capacity");
  narsil_field_tokens unordered[] = {request.fields[1], request.fields[0]};
  request.ordinal = 0;
  request.fields = unordered;
  check(narsil_remove_frozen_document(workspace, &request) == NARSIL_INVALID_ARGUMENT && states_equal(&before, state),
        "frozen removal refuses unordered fields atomically");
}

static void saturated_counts(narsil_workspace *workspace, narsil_remove_frozen_request request) {
  segment_fixture segment;
  build_segment(&segment, 1);
  uint32_t huge[] = {UINT32_MAX};
  segment.surfaces.counts = huge;
  segment.spellings.counts = huge;
  state_fixture state = {0};
  state.surfaces = UINT32_MAX - 1;
  state.spellings = UINT32_MAX - 1;
  narsil_frozen_segment_state view = state_of(&state, PENDING_DOCUMENTS, PENDING_TOKENS);
  request.segment = &segment.segment;
  request.state = &view;
  check(remove_ordinal(workspace, request, 0) == NARSIL_OK &&
            narsil_settle_frozen_state(workspace, &segment.segment, &view, NULL) == NARSIL_OK &&
            state.surfaces == UINT32_MAX && state.spellings == UINT32_MAX,
        "settled counts saturate at the stored uint32 count without wrapping");
}

void frozen_removal_checks(narsil_workspace *workspace) {
  uint16_t units[] = {'h', 'a', 'r', 'b', 'o', 'r', 'h', 'a', 'r', 'b', 'o', 'r', 's'};
  narsil_token token = {0, 0, HARBOR_LENGTH, HARBOR_LENGTH, HARBORS_LENGTH, 0, 0, NARSIL_NO_TERM_SLOT};
  narsil_field_tokens fields[] = {{0, {&token, 1, units, sizeof units / sizeof units[0]}},
                                  {1, {&token, 1, units, sizeof units / sizeof units[0]}}};
  segment_fixture segment;
  build_segment(&segment, 1);
  state_fixture state = {0};
  narsil_frozen_segment_state view = state_of(&state, PENDING_DOCUMENTS, PENDING_TOKENS);
  narsil_remove_frozen_request request = {&segment.segment, &view, 0, fields, FIELD_COUNT, NULL};
  prepared_removals(workspace, request, &state);
  deferred_counts(workspace, request, &state);
  order_independence(workspace, request, 1);
  order_independence(workspace, request, 0);
  full_regions(workspace, request);
  refused_states(workspace, request, &state);
  saturated_counts(workspace, request);
  check(TERM_COUNTS[0] == 2 && SURFACE_COUNTS[0] == 3 && SPELLING_COUNTS[0] == 2 && POSTING_DOCUMENTS[2] == 1,
        "frozen removal leaves shared source counts and postings unchanged");
}

enum { REFUSED_ROOM = 8, REFUSED_SUGGESTION_WORDS = REFUSED_ROOM * NARSIL_SUGGESTION_WORDS };

static const uint16_t REFUSED_UNITS[] = {'h', 'a', 'r', 'b', 'o', 'r', 'h', 'a', 'r', 'b', 'o', 'r', 's'};

typedef struct {
  segment_fixture segment;
  narsil_frozen_segment_state view;
  narsil_token token;
  narsil_field_tokens fields[FIELD_COUNT];
  state_fixture state;
  uint32_t entries[PREPARED_REPLACEMENTS * 2];
  double values[PREPARED_REPLACEMENTS];
  uint64_t written;
  uint32_t segments[REFUSED_ROOM];
  uint32_t tokens[REFUSED_ROOM];
  double factors[REFUSED_ROOM];
  uint32_t terms[REFUSED_SUGGESTION_WORDS];
  uint32_t starts[REFUSED_ROOM];
  uint32_t spellings[REFUSED_SUGGESTION_WORDS];
  double occurrences[REFUSED_ROOM];
  uint32_t count;
} frozen_inputs;

static frozen_inputs *prepare_frozen(int indexed) {
  frozen_inputs *inputs = calloc(1, sizeof *inputs);
  if (inputs == NULL) { return NULL; }
  build_segment(&inputs->segment, indexed);
  inputs->view = state_of(&inputs->state, PENDING_DOCUMENTS, PENDING_TOKENS);
  inputs->token = (narsil_token){0, 0, HARBOR_LENGTH, HARBOR_LENGTH, HARBORS_LENGTH, 0, 0, NARSIL_NO_TERM_SLOT};
  for (uint32_t field = 0; field < FIELD_COUNT; field++) {
    inputs->fields[field] = (narsil_field_tokens){
        (uint16_t)field, {&inputs->token, 1, REFUSED_UNITS, sizeof REFUSED_UNITS / sizeof REFUSED_UNITS[0]}};
  }
  return inputs;
}

static void *prepare_indexed_frozen(void) { return prepare_frozen(1); }

static void *prepare_scanned_frozen(void) { return prepare_frozen(0); }

static narsil_remove_frozen_request refused_request(frozen_inputs *inputs, uint32_t ordinal) {
  return (narsil_remove_frozen_request){&inputs->segment.segment, &inputs->view, ordinal,
                                        inputs->fields,           FIELD_COUNT,   NULL};
}

static narsil_status remove_and_settle(narsil_workspace *workspace, void *opaque) {
  frozen_inputs *inputs = opaque;
  narsil_remove_frozen_request request = refused_request(inputs, 0);
  narsil_status status = narsil_remove_frozen_document(workspace, &request);
  request.ordinal = 1;
  if (status == NARSIL_OK) { status = narsil_remove_frozen_document(workspace, &request); }
  return status == NARSIL_OK ? narsil_settle_frozen_state(workspace, request.segment, request.state, NULL) : status;
}

static narsil_status prepare_refused_removal(narsil_workspace *workspace, void *opaque) {
  frozen_inputs *inputs = opaque;
  narsil_remove_frozen_request request = refused_request(inputs, PREPARED_ORDINAL);
  narsil_frozen_removal_output output = {inputs->entries, inputs->values, PREPARED_REPLACEMENTS, PREPARED_REPLACEMENTS};
  size_t written = 0;
  narsil_status status = narsil_prepare_frozen_removal(workspace, &request, &output, &written);
  inputs->written = written;
  return status;
}

static narsil_expansion_output frozen_output(frozen_inputs *inputs) {
  return (narsil_expansion_output){inputs->segments, REFUSED_ROOM,    inputs->tokens,
                                   REFUSED_ROOM,     inputs->factors, REFUSED_ROOM};
}

static narsil_status expand_frozen_prefix(narsil_workspace *workspace, void *opaque) {
  frozen_inputs *inputs = opaque;
  static const uint16_t text[] = {'h', 'a', 'r'};
  narsil_expansion_segment source = {.frozen = &inputs->segment.segment, .state = &inputs->view};
  narsil_prefix_request request = {&source, 1, text, 3, text, 3, text, 3};
  narsil_expansion_output output = frozen_output(inputs);
  return narsil_expand_prefix(workspace, &request, &output, &inputs->count);
}

static narsil_status suggest_frozen_terms(narsil_workspace *workspace, void *opaque) {
  frozen_inputs *inputs = opaque;
  static const uint16_t text[] = {'h', 'a', 'r', 'b'};
  narsil_expansion_segment source = {.frozen = &inputs->segment.segment, .state = &inputs->view};
  narsil_suggestion_request request = {&source, 1, text, 4, text, 4, REFUSED_ROOM};
  narsil_suggestion_output output = {inputs->terms,     REFUSED_SUGGESTION_WORDS, inputs->starts,      REFUSED_ROOM,
                                     inputs->spellings, REFUSED_SUGGESTION_WORDS, inputs->occurrences, REFUSED_ROOM};
  return narsil_suggest_terms(workspace, &request, &output, &inputs->count);
}

static uint64_t digest_frozen(const void *opaque) {
  const frozen_inputs *inputs = opaque;
  return digest_bytes(DIGEST_START, &inputs->state, sizeof *inputs - offsetof(frozen_inputs, state));
}

void frozen_allocation_failures(void) {
  const failing_call calls[] = {
      {"frozen removals settled through the removal index", prepare_indexed_frozen, remove_and_settle, digest_frozen,
       free},
      {"frozen removals settled through a posting scan", prepare_scanned_frozen, remove_and_settle, digest_frozen,
       free},
      {"a prepared frozen removal", prepare_indexed_frozen, prepare_refused_removal, digest_frozen, free},
      {"a prefix expansion over a frozen segment", prepare_indexed_frozen, expand_frozen_prefix, digest_frozen, free},
      {"term suggestions over a frozen segment", prepare_indexed_frozen, suggest_frozen_terms, digest_frozen, free},
  };
  for (size_t at = 0; at < sizeof calls / sizeof calls[0]; at++) { refuse_each_allocation(&calls[at]); }
}
