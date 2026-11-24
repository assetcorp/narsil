#include "fixture.h"

#include "../include/narsil_analysis.h"
#include "../include/narsil_core.h"
#include "../include/narsil_highlight.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

enum {
  BOAT_TEXT_LENGTH = 7,
  BOAT_LENGTH = 4,
  OKO_LENGTH = 3,
  OK_LENGTH = 2,
  KO_LENGTH = 2,
  SNIPPET_CAPACITY = 16,
  POSITION_WORDS = 4,
  NO_MATCH = 0,
  ONE_MATCH = 1,
};

typedef struct {
  narsil_analyser *analyser;
  narsil_workspace *workspace;
  narsil_highlight_request request;
  uint32_t positions[POSITION_WORDS];
  uint32_t count;
} folded_case;

static const uint16_t BOAT_TEXT[] = {0x1ECD, 'k', 0x1ECD, 0x0300, ' ', 'n', 'i'};
static const uint16_t PLAIN_OKO[] = {'o', 'k', 'o'};
static const uint16_t PLAIN_OK[] = {'o', 'k'};
static const uint16_t PLAIN_KO[] = {'k', 'o'};
static const uint16_t BEFORE[] = {'['};
static const uint16_t AFTER[] = {']'};

static narsil_status highlight_case(folded_case *run, const narsil_folded_highlight *folded) {
  uint16_t snippet[SNIPPET_CAPACITY] = {0};
  uint32_t length = 0;
  run->request.query.folded = folded;
  narsil_highlight_output output = {snippet, SNIPPET_CAPACITY, run->positions, POSITION_WORDS, &length, 1};
  return narsil_highlight(run->analyser, run->workspace, &run->request, &output, &run->count);
}

static int marks_the_boat(folded_case *run, const narsil_folded_highlight *folded) {
  return highlight_case(run, folded) == NARSIL_OK && run->count == ONE_MATCH && run->positions[0] == 0 &&
         run->positions[1] == BOAT_LENGTH;
}

static int marks_nothing(folded_case *run, const narsil_folded_highlight *folded) {
  return highlight_case(run, folded) == NARSIL_OK && run->count == NO_MATCH;
}

void folded_highlight_checks(narsil_workspace *workspace) {
  folded_case run = {0};
  run.workspace = workspace;
  check(narsil_analyser_create(&run.analyser) == NARSIL_OK, "folded highlighting allocates an analyser");
  if (run.analyser == NULL) { return; }
  uint32_t yoruba = 0;
  check(narsil_language_lookup("yoruba", strlen("yoruba"), &yoruba) == NARSIL_OK, "folded highlighting finds Yoruba");
  run.request = (narsil_highlight_request){yoruba, {BOAT_TEXT, BOAT_TEXT_LENGTH}, {0}, {BEFORE, 1}, {AFTER, 1}, 0};
  narsil_highlight_term key = {{PLAIN_OKO, OKO_LENGTH}, 0};
  check(marks_nothing(&run, NULL), "a query typed without marks marks nothing where the index does not fold");
  narsil_folded_highlight by_key = {&key, 1, {NULL, 0}, NULL, 0};
  check(marks_the_boat(&run, &by_key), "a folded key marks the whole marked word, tone mark included");
  narsil_folded_highlight by_prefix = {NULL, 0, {PLAIN_OK, OK_LENGTH}, NULL, 0};
  check(marks_the_boat(&run, &by_prefix), "a folded prefix marks a marked word that starts with it");
  narsil_highlight_text inner = {PLAIN_KO, KO_LENGTH};
  narsil_folded_highlight by_part = {NULL, 0, {NULL, 0}, &inner, 1};
  check(marks_the_boat(&run, &by_part), "a folded partial word marks a longer marked word that holds it");
  narsil_highlight_text whole = {PLAIN_OKO, OKO_LENGTH};
  narsil_folded_highlight by_whole = {NULL, 0, {NULL, 0}, &whole, 1};
  check(marks_nothing(&run, &by_whole), "a folded partial word marks no word whose fold is as short as it");
  narsil_folded_highlight missing_keys = {NULL, 1, {NULL, 0}, NULL, 0};
  run.count = SNIPPET_CAPACITY;
  check(highlight_case(&run, &missing_keys) == NARSIL_INVALID_ARGUMENT && run.count == SNIPPET_CAPACITY,
        "folded highlighting refuses a key list that it cannot read");
  narsil_analyser_destroy(run.analyser);
}
