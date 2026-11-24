#ifndef NARSIL_TEST_FOLDED_FIXTURE_H
#define NARSIL_TEST_FOLDED_FIXTURE_H

#include "segment_fixture.h"

#include "../include/narsil_analysis.h"
#include "../include/narsil_core.h"
#include "../include/narsil_expansion.h"
#include "../include/narsil_folding.h"

#include <stddef.h>
#include <stdint.h>

enum {
  BOAT_LENGTH = 4,
  SPEAR_LENGTH = 5,
  BOOK_LENGTH = 3,
  EACH_LENGTH = 10,
  BEAN_CAKE_LENGTH = 5,
  BOAT_TOKEN = 0,
  SPEAR_TOKEN = 1,
  BOOK_TOKEN = 2,
  EACH_TOKEN = 3,
  BEAN_CAKE_TOKEN = 4,
  FOLDED_DOCUMENTS = 5,
  FOLDED_KEY_ROOM = 32,
  FOLDED_ROOM = 8
};

extern const uint16_t BOAT[BOAT_LENGTH];
extern const uint16_t SPEAR[SPEAR_LENGTH];
extern const uint16_t BOOK[BOOK_LENGTH];
extern const uint16_t EACH[EACH_LENGTH];
extern const uint16_t BEAN_CAKE[BEAN_CAKE_LENGTH];

typedef struct {
  segment_fixture *data;
  narsil_expansion_segment source;
  narsil_fold_table *table;
  narsil_analyser *analyser;
  uint32_t language;
} folded_segment;

typedef struct {
  uint32_t segments[FOLDED_ROOM];
  uint32_t tokens[FOLDED_ROOM];
  double factors[FOLDED_ROOM];
  uint32_t starts[FOLDED_ROOM];
  uint32_t count;
} folded_answer;

typedef struct {
  uint16_t units[FOLDED_KEY_ROOM];
  uint32_t length;
} folded_text;

folded_segment *folded_segment_create(void);
void folded_segment_release(folded_segment *segment);
narsil_status folded_segment_index(narsil_workspace *workspace, folded_segment *segment, uint32_t ordinal,
                                   const uint16_t *word, uint32_t length);
narsil_status folded_segment_update(narsil_workspace *workspace, folded_segment *segment);
narsil_status folded_text_of(folded_segment *segment, const uint16_t *units, uint32_t length, uint32_t flags,
                             folded_text *text);
narsil_status folded_terms(narsil_workspace *workspace, folded_segment *segment, const narsil_folded_word *word,
                           folded_answer *answer);
narsil_status folded_prefix(narsil_workspace *workspace, folded_segment *segment, const uint16_t *typed,
                            uint32_t length, folded_answer *answer);
narsil_status folded_partial(narsil_workspace *workspace, folded_segment *segment, const narsil_partial_word *word,
                             folded_answer *answer);

#endif
