#include "allocation_failures.h"
#include "fixture.h"

#include "../include/narsil_analysis.h"
#include "../include/narsil_core.h"
#include "../include/narsil_expansion.h"
#include "../include/narsil_folding.h"
#include "../include/narsil_frozen_segments.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

enum {
  FROZEN_TERMS = 3,
  FROZEN_POSTINGS = 4,
  FROZEN_DOCUMENTS = 4,
  FROZEN_SPELLINGS = 2,
  FROZEN_PENDING = 4,
  FROZEN_PENDING_UNITS = 64,
  FROZEN_ROOM = 8,
  FROZEN_KEY_ROOM = 32,
  BOOK_ORDINAL = 0,
  BOAT_ORDINAL = 1,
  SPEAR_ORDINAL = 2,
  THREE_POINTS = 3,
  FOUR_POINTS = 4,
  FIVE_POINTS = 5
};

static const uint8_t TERM_TEXT[] = "\xC3\xAC"
                                   "w\xC3\xA9"
                                   "\xE1\xBB\x8D"
                                   "k\xE1\xBB\x8D\xCC\x80"
                                   "\xE1\xBB\x8D\xCC\x80"
                                   "k\xE1\xBB\x8D\xCC\x80";
static const uint32_t TERM_OFFSETS[] = {0, 5, 14, 25};
static const uint32_t TERM_COUNTS[] = {1, 2, 1};
static const uint32_t PAYLOAD_SLOTS[] = {0, 1, 2};
static const uint32_t POSTING_OFFSETS[] = {0, 1, 3, 4};
static const uint32_t POSTING_DOCUMENTS[] = {0, 1, 3, 2};
static const uint16_t POSTING_FREQUENCIES[] = {1, 1, 1, 1};
static const uint16_t POSTING_FIELDS[] = {0, 0, 0, 0};
static const uint8_t SURFACE_TEXT[] = "\xE1\xBB\x8D\xCC\x80"
                                      "k\xE1\xBB\x8D\xCC\x80\xE1\xBB\x8D\xCC\x80"
                                      "\xE1\xBB\x8D\xCC\x80"
                                      "k\xE1\xBB\x8D\xCC\x80";
static const uint32_t SURFACE_OFFSETS[] = {0, 16, 27};
static const uint32_t SURFACE_COUNTS[] = {1};
static const uint8_t SPELLING_TEXT[] = "\xE1\xBB\x8D"
                                       "k\xE1\xBB\x8D\xCC\x80"
                                       "\xE1\xBB\x8D\xCC\x80"
                                       "k\xE1\xBB\x8D\xCC\x80\xE1\xBB\x8D\xCC\x80";
static const uint32_t SPELLING_OFFSETS[] = {0, 9, 25};
static const uint32_t SPELLING_COUNTS[] = {2, 1};
static const uint32_t SPELLING_TOKENS[] = {BOAT_ORDINAL, SPEAR_ORDINAL};
static const uint8_t PARTIAL_FIELDS[] = {1};
static const uint16_t PLAIN_OKO[] = {'o', 'k', 'o'};
static const uint16_t PLAIN_OKOO[] = {'o', 'k', 'o', 'o'};
static const uint16_t PLAIN_KOO[] = {'k', 'o', 'o'};
static const char YORUBA[] = "yoruba";

typedef struct {
  narsil_frozen_strings surfaces;
  narsil_frozen_strings spellings;
  narsil_frozen_segment segment;
  uint32_t tombstones;
  uint32_t tombstone_count;
  uint32_t removed_documents[FROZEN_TERMS];
  double removed_occurrences[FROZEN_TERMS];
  uint32_t removed_surfaces[1];
  uint32_t removed_spellings[FROZEN_SPELLINGS];
  uint32_t pending_header[NARSIL_PENDING_HEADER_WORDS];
  uint32_t pending_documents[FROZEN_PENDING];
  uint32_t pending_tokens[FROZEN_PENDING * NARSIL_PENDING_TOKEN_WORDS];
  uint16_t pending_units[FROZEN_PENDING_UNITS];
  narsil_frozen_segment_state state;
  narsil_expansion_segment source;
  narsil_analyser *analyser;
  narsil_fold_table *table;
  uint32_t language;
  uint32_t segments[FROZEN_ROOM];
  uint32_t tokens[FROZEN_ROOM];
  double factors[FROZEN_ROOM];
  uint32_t starts[FROZEN_ROOM];
  uint32_t count;
} frozen_folds;

static void point_at_arrays(frozen_folds *folds) {
  folds->surfaces = (narsil_frozen_strings){SURFACE_TEXT, sizeof SURFACE_TEXT - 1, SURFACE_OFFSETS, SURFACE_COUNTS, 1};
  folds->spellings = (narsil_frozen_strings){SPELLING_TEXT, sizeof SPELLING_TEXT - 1, SPELLING_OFFSETS, SPELLING_COUNTS,
                                             FROZEN_SPELLINGS};
  folds->segment =
      (narsil_frozen_segment){.terms = {TERM_TEXT, sizeof TERM_TEXT - 1, TERM_OFFSETS, TERM_COUNTS, FROZEN_TERMS},
                              .payload_slots = PAYLOAD_SLOTS,
                              .posting_offsets = POSTING_OFFSETS,
                              .posting_documents = POSTING_DOCUMENTS,
                              .posting_frequencies = POSTING_FREQUENCIES,
                              .posting_fields = POSTING_FIELDS,
                              .posting_count = FROZEN_POSTINGS,
                              .surfaces = &folds->surfaces,
                              .spellings = &folds->spellings,
                              .spelling_tokens = SPELLING_TOKENS,
                              .partial_fields = PARTIAL_FIELDS,
                              .field_count = 1,
                              .document_count = FROZEN_DOCUMENTS};
  folds->state = (narsil_frozen_segment_state){.tombstones = &folds->tombstones,
                                               .tombstone_count = &folds->tombstone_count,
                                               .removed_documents = folds->removed_documents,
                                               .removed_occurrences = folds->removed_occurrences,
                                               .removed_surfaces = folds->removed_surfaces,
                                               .removed_spellings = folds->removed_spellings,
                                               .pending_header = folds->pending_header,
                                               .pending_documents = folds->pending_documents,
                                               .pending_document_capacity = FROZEN_PENDING,
                                               .pending_tokens = folds->pending_tokens,
                                               .pending_token_capacity = FROZEN_PENDING,
                                               .pending_units = folds->pending_units,
                                               .pending_unit_capacity = FROZEN_PENDING_UNITS};
  folds->source = (narsil_expansion_segment){.frozen = &folds->segment, .state = &folds->state};
}

static void release_folds(void *opaque) {
  frozen_folds *folds = opaque;
  if (folds == NULL) { return; }
  narsil_fold_table_destroy(folds->table);
  narsil_analyser_destroy(folds->analyser);
  free(folds);
}

static frozen_folds *create_folds(void) {
  frozen_folds *folds = calloc(1, sizeof *folds);
  if (folds == NULL) { return NULL; }
  point_at_arrays(folds);
  if (narsil_analyser_create(&folds->analyser) != NARSIL_OK ||
      narsil_language_lookup(YORUBA, sizeof YORUBA - 1, &folds->language) != NARSIL_OK) {
    release_folds(folds);
    return NULL;
  }
  return folds;
}

static narsil_status update_table(narsil_workspace *workspace, frozen_folds *folds) {
  if (folds->table == NULL) {
    narsil_status created = narsil_fold_table_create(&folds->table);
    if (created != NARSIL_OK) { return created; }
  }
  return narsil_fold_table_update(workspace, folds->analyser, folds->table, &folds->source, folds->language);
}

static narsil_status variants_of(narsil_workspace *workspace, frozen_folds *folds, const uint16_t *own,
                                 uint32_t length) {
  narsil_term term = {NULL, 0};
  narsil_status status = narsil_fold_spelling(folds->analyser, folds->language, own, length, NARSIL_FOLD_STEM, &term);
  if (status != NARSIL_OK || term.length > FROZEN_KEY_ROOM) { return status == NARSIL_OK ? NARSIL_NEEDS_ROOM : status; }
  uint16_t key[FROZEN_KEY_ROOM];
  memcpy(key, term.units, term.length * sizeof *key);
  narsil_folded_word word = {key, term.length, own, length, NULL, 0, 0, 0};
  const narsil_fold_table *const tables[] = {folds->table};
  narsil_folded_request request = {&folds->source, tables, 1, &word, 1};
  narsil_folded_output output = {folds->segments, FROZEN_ROOM, folds->tokens, FROZEN_ROOM, folds->starts, FROZEN_ROOM};
  folds->count = UINT32_MAX;
  return narsil_expand_folded_terms(workspace, &request, &output, &folds->count);
}

static narsil_status prefix_of(narsil_workspace *workspace, frozen_folds *folds, const uint16_t *typed,
                               uint32_t length) {
  const narsil_fold_table *const tables[] = {folds->table};
  narsil_folded_prefix_request request = {
      {&folds->source, 1, typed, length, typed, length, typed, length}, tables, typed, length};
  narsil_expansion_output output = {folds->segments, FROZEN_ROOM,    folds->tokens,
                                    FROZEN_ROOM,     folds->factors, FROZEN_ROOM};
  folds->count = UINT32_MAX;
  return narsil_expand_folded_prefix(workspace, &request, &output, &folds->count);
}

static narsil_status partial_of(narsil_workspace *workspace, frozen_folds *folds, const uint16_t *written,
                                uint32_t length) {
  const narsil_fold_table *const tables[] = {folds->table};
  narsil_frozen_runs runs = {0};
  narsil_partial_word word = {written, length, written, length, 0, 0};
  narsil_term probe = {written, length};
  narsil_folded_partial_request request = {{&folds->source, &runs, 1, &word, 1}, tables, &probe};
  narsil_partial_output output = {
      {folds->segments, FROZEN_ROOM, folds->tokens, FROZEN_ROOM, folds->factors, FROZEN_ROOM},
      folds->starts,
      FROZEN_ROOM};
  folds->count = UINT32_MAX;
  return narsil_expand_folded_partial_words(workspace, &request, &output, &folds->count);
}

static int answer_is(const frozen_folds *folds, const uint32_t *tokens, const double *factors, uint32_t count) {
  if (folds->count != count) { return 0; }
  for (uint32_t at = 0; at < count; at++) {
    if (folds->segments[at] != 0 || folds->tokens[at] != tokens[at] ||
        (factors != NULL && folds->factors[at] != factors[at])) {
      return 0;
    }
  }
  return 1;
}

static void live_checks(narsil_workspace *workspace, frozen_folds *folds) {
  const uint32_t boat[] = {BOAT_ORDINAL};
  check(variants_of(workspace, folds, PLAIN_OKO, THREE_POINTS) == NARSIL_OK && answer_is(folds, boat, NULL, 1),
        "a frozen token written only through its surface is not a variant of its own fold");
  const uint32_t spear[] = {SPEAR_ORDINAL};
  check(variants_of(workspace, folds, PLAIN_OKOO, FOUR_POINTS) == NARSIL_OK && answer_is(folds, spear, NULL, 1),
        "a frozen surface reaches its token through the fold of the surface");
  const uint32_t completions[] = {BOAT_ORDINAL, SPEAR_ORDINAL};
  const double factors[] = {(double)THREE_POINTS / (double)FOUR_POINTS, (double)THREE_POINTS / (double)FIVE_POINTS};
  check(prefix_of(workspace, folds, PLAIN_OKO, THREE_POINTS) == NARSIL_OK && answer_is(folds, completions, factors, 2),
        "a frozen prefix completes to a token and to the token of a marked surface");
  const double partial_factor[] = {(double)THREE_POINTS / (double)FOUR_POINTS};
  check(partial_of(workspace, folds, PLAIN_KOO, THREE_POINTS) == NARSIL_OK &&
            answer_is(folds, spear, partial_factor, 1) && folds->starts[1] == 1,
        "a frozen partial word reaches a marked spelling whose fold holds it");
}

static void removed_checks(narsil_workspace *workspace, frozen_folds *folds) {
  folds->removed_documents[SPEAR_ORDINAL] = 1;
  folds->removed_occurrences[SPEAR_ORDINAL] = 1;
  folds->removed_surfaces[0] = 1;
  folds->removed_spellings[1] = 1;
  check(narsil_fold_table_current(folds->table, &folds->source, folds->language) == 1,
        "a frozen removal keeps the fold table current");
  check(variants_of(workspace, folds, PLAIN_OKOO, FOUR_POINTS) == NARSIL_OK && folds->count == 0,
        "a removed frozen surface adds no variant");
  const uint32_t boat[] = {BOAT_ORDINAL};
  check(prefix_of(workspace, folds, PLAIN_OKO, THREE_POINTS) == NARSIL_OK && answer_is(folds, boat, NULL, 1),
        "a removed frozen word completes no prefix");
  check(partial_of(workspace, folds, PLAIN_KOO, THREE_POINTS) == NARSIL_OK && folds->count == 0,
        "a removed frozen spelling adds no partial word");
}

void folded_frozen_checks(narsil_workspace *workspace) {
  frozen_folds *folds = create_folds();
  check(folds != NULL, "the frozen folding fixture has memory");
  if (folds == NULL) { return; }
  check(update_table(workspace, folds) == NARSIL_OK &&
            narsil_fold_table_current(folds->table, &folds->source, folds->language) == 1,
        "an update builds the fold table of a frozen segment");
  live_checks(workspace, folds);
  removed_checks(workspace, folds);
  release_folds(folds);
}

static void *prepare_frozen_folds(void) { return create_folds(); }

static narsil_status fold_frozen_segment(narsil_workspace *workspace, void *opaque) {
  frozen_folds *folds = opaque;
  narsil_status status = update_table(workspace, folds);
  if (status == NARSIL_OK) { status = variants_of(workspace, folds, PLAIN_OKO, THREE_POINTS); }
  if (status == NARSIL_OK) { status = prefix_of(workspace, folds, PLAIN_OKO, THREE_POINTS); }
  if (status == NARSIL_OK) { status = partial_of(workspace, folds, PLAIN_KOO, THREE_POINTS); }
  return status;
}

static uint64_t digest_frozen_folds(const void *opaque) {
  const frozen_folds *folds = opaque;
  return digest_bytes(DIGEST_START, folds->segments,
                      offsetof(frozen_folds, count) + sizeof folds->count - offsetof(frozen_folds, segments));
}

void folded_frozen_allocation_failures(void) {
  const failing_call call = {"a fold table and folded expansions over a frozen segment", prepare_frozen_folds,
                             fold_frozen_segment, digest_frozen_folds, release_folds};
  refuse_each_allocation(&call);
}
