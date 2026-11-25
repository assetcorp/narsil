#include "allocation_failures.h"
#include "fixture.h"
#include "folded_fixture.h"

#include "../include/narsil_analysis.h"
#include "../include/narsil_core.h"
#include "../include/narsil_expansion.h"
#include "../include/narsil_folding.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

enum {
  TERM_GENERATION_WORD = 3,
  TWO_POINTS = 2,
  THREE_POINTS = 3,
  FOUR_POINTS = 4,
  FIVE_POINTS = 5,
  SEVEN_POINTS = 7,
  TEN_POINTS = 10,
  BEAN_CAKE_ORDINAL = 5
};

static const uint16_t PLAIN_OKO[] = {'o', 'k', 'o'};
static const uint16_t PLAIN_OKP[] = {'o', 'k', 'p'};
static const uint16_t PLAIN_ILE[] = {'i', 'l', 'e'};
static const uint16_t PLAIN_IW[] = {'i', 'w'};
static const uint16_t PLAIN_OK[] = {'o', 'k'};
static const uint16_t MARKED_OK[] = {0x1ECD, 0x0300, 'k'};
static const uint16_t PLAIN_AKA[] = {'a', 'k', 'a'};
static const uint16_t PLAIN_KOOK[] = {'k', 'o', 'o', 'k'};
static const uint16_t MARKED_KOOK[] = {'k', 0x1ECD, 0x0300, 0x1ECD, 0x0300, 'k'};
static const uint16_t PLAIN_KO[] = {'k', 'o'};

typedef struct {
  folded_text key;
  narsil_folded_word word;
  narsil_status status;
} folded_query;

static folded_query query_of(folded_segment *segment, const uint16_t *own, uint32_t length, uint32_t tolerance) {
  folded_query query;
  query.status = folded_text_of(segment, own, length, NARSIL_FOLD_STEM, &query.key);
  query.word = (narsil_folded_word){NULL, query.key.length, own, length, NULL, 0, tolerance, 0};
  return query;
}

static narsil_status terms_of(narsil_workspace *workspace, folded_segment *segment, folded_query *query,
                              folded_answer *answer) {
  answer->count = UINT32_MAX;
  if (query->status != NARSIL_OK) { return query->status; }
  query->word.key = query->key.units;
  return folded_terms(workspace, segment, &query->word, answer);
}

static int tokens_are(const folded_answer *answer, const uint32_t *tokens, uint32_t count) {
  if (answer->count != count) { return 0; }
  for (uint32_t at = 0; at < count; at++) {
    if (answer->segments[at] != 0 || answer->tokens[at] != tokens[at]) { return 0; }
  }
  return 1;
}

static int starts_are(const folded_answer *answer, uint32_t variants, uint32_t typos) {
  return answer->starts[0] == 0 && answer->starts[1] == variants && answer->starts[2] == variants + typos;
}

static void variant_checks(narsil_workspace *workspace, folded_segment *segment) {
  folded_answer answer;
  folded_query plain = query_of(segment, PLAIN_OKO, THREE_POINTS, 0);
  const uint32_t both[] = {BOAT_TOKEN, SPEAR_TOKEN};
  check(terms_of(workspace, segment, &plain, &answer) == NARSIL_OK && tokens_are(&answer, both, 2) &&
            starts_are(&answer, 2, 0),
        "a word typed without marks gains every held marked word that folds to its key, in code point order");
  folded_query marked = query_of(segment, BOAT, BOAT_LENGTH, 0);
  const uint32_t spear[] = {SPEAR_TOKEN};
  check(terms_of(workspace, segment, &marked, &answer) == NARSIL_OK && tokens_are(&answer, spear, 1) &&
            starts_are(&answer, 1, 0),
        "a marked word gains the other spellings of its key and never itself");
  narsil_term synonym = {SPEAR, SPEAR_LENGTH};
  plain.word.excluded = &synonym;
  plain.word.excluded_count = 1;
  const uint32_t boat[] = {BOAT_TOKEN};
  check(terms_of(workspace, segment, &plain, &answer) == NARSIL_OK && tokens_are(&answer, boat, 1),
        "a word that the group already holds as a synonym is never a variant");
  folded_query unknown = query_of(segment, PLAIN_ILE, THREE_POINTS, 0);
  check(terms_of(workspace, segment, &unknown, &answer) == NARSIL_OK && answer.count == 0 && starts_are(&answer, 0, 0),
        "a key that no held word folds to adds nothing");
  folded_query typo = query_of(segment, PLAIN_OKP, THREE_POINTS, 1);
  check(terms_of(workspace, segment, &typo, &answer) == NARSIL_OK && tokens_are(&answer, both, 2) &&
            starts_are(&answer, 0, 2),
        "a typo of the unmarked form reaches the marked words within the tolerance");
  folded_query near = query_of(segment, PLAIN_OKO, THREE_POINTS, 1);
  check(terms_of(workspace, segment, &near, &answer) == NARSIL_OK && tokens_are(&answer, both, 2) &&
            starts_are(&answer, 2, 0),
        "a variant never appears again among the typo matches");
}

static void refused_terms(narsil_workspace *workspace, folded_segment *segment, folded_segment *other) {
  folded_query plain = query_of(segment, PLAIN_OKO, THREE_POINTS, 0);
  plain.word.key = plain.key.units;
  const narsil_fold_table *const tables[] = {segment->table};
  narsil_folded_request request = {&segment->source, tables, 1, &plain.word, 1};
  folded_answer answer;
  narsil_folded_output output = {answer.segments, FOLDED_ROOM, answer.tokens, 1, answer.starts, FOLDED_ROOM};
  answer.count = UINT32_MAX;
  check(narsil_expand_folded_terms(workspace, &request, &output, &answer.count) == NARSIL_NEEDS_ROOM &&
            answer.count == UINT32_MAX,
        "a short token output asks for room and leaves the count unchanged");
  output.token_capacity = FOLDED_ROOM;
  output.start_capacity = 2;
  check(narsil_expand_folded_terms(workspace, &request, &output, &answer.count) == NARSIL_NEEDS_ROOM &&
            answer.count == UINT32_MAX,
        "a start output without two blocks per word asks for room");
  output.start_capacity = FOLDED_ROOM;
  output.tokens = segment->data->frequencies;
  uint32_t frequency = segment->data->frequencies[0];
  check(narsil_expand_folded_terms(workspace, &request, &output, &answer.count) == NARSIL_INVALID_ARGUMENT &&
            segment->data->frequencies[0] == frequency,
        "a folded output cannot overwrite the keyword counts that it reads");
  output.tokens = answer.tokens;
  const narsil_fold_table *const foreign[] = {other->table};
  request.tables = foreign;
  check(narsil_expand_folded_terms(workspace, &request, &output, &answer.count) == NARSIL_INVALID_ARGUMENT,
        "a fold table built for another segment is refused");
  request.tables = NULL;
  check(narsil_expand_folded_terms(workspace, &request, &output, &answer.count) == NARSIL_INVALID_ARGUMENT,
        "a request without fold tables is refused");
}

static int factors_are(const folded_answer *answer, const double *factors, uint32_t count) {
  for (uint32_t at = 0; at < count; at++) {
    if (answer->factors[at] != factors[at]) { return 0; }
  }
  return 1;
}

static void prefix_checks(narsil_workspace *workspace, folded_segment *segment) {
  folded_answer answer;
  const uint32_t book[] = {BOOK_TOKEN};
  const double book_factor[] = {(double)TWO_POINTS / (double)THREE_POINTS};
  check(folded_prefix(workspace, segment, PLAIN_IW, TWO_POINTS, &answer) == NARSIL_OK && tokens_are(&answer, book, 1) &&
            factors_are(&answer, book_factor, 1),
        "an unmarked prefix completes to a marked word");
  const uint32_t ranked[] = {BOAT_TOKEN, SPEAR_TOKEN, EACH_TOKEN};
  const double plain_factors[] = {(double)TWO_POINTS / (double)FOUR_POINTS, (double)TWO_POINTS / (double)FIVE_POINTS,
                                  (double)TWO_POINTS / (double)TEN_POINTS};
  check(folded_prefix(workspace, segment, PLAIN_OK, TWO_POINTS, &answer) == NARSIL_OK &&
            tokens_are(&answer, ranked, THREE_POINTS) && factors_are(&answer, plain_factors, THREE_POINTS),
        "folded completions rank by document frequency and then by code points");
  const double marked_factors[] = {(double)THREE_POINTS / (double)FOUR_POINTS,
                                   (double)THREE_POINTS / (double)FIVE_POINTS,
                                   (double)THREE_POINTS / (double)TEN_POINTS};
  check(folded_prefix(workspace, segment, MARKED_OK, THREE_POINTS, &answer) == NARSIL_OK &&
            tokens_are(&answer, ranked, THREE_POINTS) && factors_are(&answer, marked_factors, THREE_POINTS),
        "a marked prefix completes once to each word that its plain or folded form reaches");
}

static void partial_checks(narsil_workspace *workspace, folded_segment *segment) {
  folded_answer answer;
  const uint32_t each[] = {EACH_TOKEN};
  narsil_partial_word plain = {PLAIN_KOOK, FOUR_POINTS, PLAIN_KOOK, FOUR_POINTS, 0, 0};
  check(folded_partial(workspace, segment, &plain, &answer) == NARSIL_OK && tokens_are(&answer, each, 1) &&
            answer.factors[0] == (double)FOUR_POINTS / (double)SEVEN_POINTS && answer.starts[0] == 0 &&
            answer.starts[1] == 1,
        "an unmarked partial word reaches a longer marked word whose fold holds it");
  narsil_partial_word marked = {MARKED_KOOK, sizeof MARKED_KOOK / sizeof *MARKED_KOOK,
                                MARKED_KOOK, sizeof MARKED_KOOK / sizeof *MARKED_KOOK,
                                0,           0};
  check(folded_partial(workspace, segment, &marked, &answer) == NARSIL_OK && tokens_are(&answer, each, 1) &&
            answer.factors[0] == (double)FOUR_POINTS / (double)SEVEN_POINTS,
        "a marked partial word scores against its folded length");
  narsil_partial_word own = {PLAIN_KOOK, FOUR_POINTS, EACH, EACH_LENGTH, 0, 0};
  check(folded_partial(workspace, segment, &own, &answer) == NARSIL_OK && answer.count == 0 && answer.starts[1] == 0,
        "a partial word never adds the word that the query already holds");
  narsil_partial_word short_word = {PLAIN_KO, TWO_POINTS, PLAIN_KO, TWO_POINTS, 0, 0};
  check(folded_partial(workspace, segment, &short_word, &answer) == NARSIL_OK && answer.count == 0,
        "a partial word shorter than a run adds nothing");
}

static void table_lifecycle(narsil_workspace *workspace, folded_segment *segment) {
  check(narsil_fold_table_current(segment->table, &segment->source, segment->language) == 0,
        "a new fold table is stale until its first update");
  folded_answer answer;
  check(folded_prefix(workspace, segment, PLAIN_IW, TWO_POINTS, &answer) == NARSIL_INVALID_ARGUMENT &&
            answer.count == UINT32_MAX,
        "a query refuses a fold table that has never been built");
  check(folded_segment_update(workspace, segment) == NARSIL_OK &&
            narsil_fold_table_current(segment->table, &segment->source, segment->language) == 1 &&
            narsil_fold_table_bytes(segment->table) > 0,
        "an update builds the fold table for its segment");
  check(folded_segment_update(workspace, segment) == NARSIL_OK, "an update of a current table is a no-op");
  variant_checks(workspace, segment);
  prefix_checks(workspace, segment);
  partial_checks(workspace, segment);
  check(folded_segment_index(workspace, segment, BEAN_CAKE_ORDINAL, BEAN_CAKE, BEAN_CAKE_LENGTH) == NARSIL_OK &&
            narsil_fold_table_current(segment->table, &segment->source, segment->language) == 0,
        "a write to the segment makes its fold table stale");
  check(folded_prefix(workspace, segment, PLAIN_AKA, THREE_POINTS, &answer) == NARSIL_INVALID_ARGUMENT,
        "a query refuses a stale fold table");
  const uint32_t bean_cake[] = {BEAN_CAKE_TOKEN};
  check(folded_segment_update(workspace, segment) == NARSIL_OK &&
            folded_prefix(workspace, segment, PLAIN_AKA, THREE_POINTS, &answer) == NARSIL_OK &&
            tokens_are(&answer, bean_cake, 1),
        "an update extends the fold table with the new word");
  segment->data->terms.header[TERM_GENERATION_WORD]++;
  const uint32_t ranked[] = {BOAT_TOKEN, SPEAR_TOKEN, EACH_TOKEN};
  check(narsil_fold_table_current(segment->table, &segment->source, segment->language) == 0 &&
            folded_segment_update(workspace, segment) == NARSIL_OK &&
            folded_prefix(workspace, segment, PLAIN_OK, TWO_POINTS, &answer) == NARSIL_OK &&
            tokens_are(&answer, ranked, THREE_POINTS),
        "a new term generation rebuilds the fold table from the start");
  check(narsil_fold_table_update(workspace, segment->analyser, segment->table, &segment->source,
                                 narsil_language_count()) == NARSIL_INVALID_ARGUMENT,
        "an update refuses a language that the core does not hold");
  check(narsil_fold_table_create(NULL) == NARSIL_INVALID_ARGUMENT, "creation refuses a missing table pointer");
  narsil_fold_table_destroy(NULL);
}

typedef struct {
  folded_segment *segment;
  folded_answer terms;
  folded_answer prefix;
  folded_answer partial;
} folded_failure;

static void release_failure(void *opaque) {
  folded_failure *failure = opaque;
  folded_segment_release(failure->segment);
  free(failure);
}

static void *prepare_failure(void) {
  folded_failure *failure = calloc(1, sizeof *failure);
  if (failure == NULL) { return NULL; }
  failure->segment = folded_segment_create();
  if (failure->segment == NULL) {
    free(failure);
    return NULL;
  }
  narsil_fold_table_destroy(failure->segment->table);
  failure->segment->table = NULL;
  return failure;
}

static narsil_status fold_growing_segment(narsil_workspace *workspace, void *opaque) {
  folded_failure *failure = opaque;
  folded_segment *segment = failure->segment;
  narsil_status status = segment->table == NULL ? narsil_fold_table_create(&segment->table) : NARSIL_OK;
  if (status == NARSIL_OK) { status = folded_segment_update(workspace, segment); }
  folded_query marked = query_of(segment, BOAT, BOAT_LENGTH, 1);
  if (status == NARSIL_OK) { status = terms_of(workspace, segment, &marked, &failure->terms); }
  if (status == NARSIL_OK) { status = folded_prefix(workspace, segment, MARKED_OK, THREE_POINTS, &failure->prefix); }
  narsil_partial_word word = {MARKED_KOOK, sizeof MARKED_KOOK / sizeof *MARKED_KOOK,
                              MARKED_KOOK, sizeof MARKED_KOOK / sizeof *MARKED_KOOK,
                              1,           0};
  if (status == NARSIL_OK) { status = folded_partial(workspace, segment, &word, &failure->partial); }
  return status;
}

static uint64_t digest_failure(const void *opaque) {
  const folded_failure *failure = opaque;
  uint64_t digest = digest_bytes(DIGEST_START, &failure->terms, sizeof failure->terms);
  digest = digest_bytes(digest, &failure->prefix, sizeof failure->prefix);
  return digest_bytes(digest, &failure->partial, sizeof failure->partial);
}

void folded_allocation_failures(void) {
  const failing_call call = {"a fold table and folded expansions over a growing segment", prepare_failure,
                             fold_growing_segment, digest_failure, release_failure};
  refuse_each_allocation(&call);
  folded_frozen_allocation_failures();
}

void folded_expansion_checks(narsil_workspace *workspace) {
  folded_segment *segment = folded_segment_create();
  folded_segment *other = folded_segment_create();
  check(segment != NULL && other != NULL, "the folded expansion segments have memory");
  if (segment != NULL && other != NULL) {
    table_lifecycle(workspace, segment);
    check(folded_segment_update(workspace, other) == NARSIL_OK, "a second segment builds its fold table");
    refused_terms(workspace, segment, other);
  }
  folded_segment_release(segment);
  folded_segment_release(other);
}
