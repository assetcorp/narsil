#include "folded_fixture.h"

#include "segment_fixture.h"

#include "../include/narsil_analysis.h"
#include "../include/narsil_core.h"
#include "../include/narsil_expansion.h"
#include "../include/narsil_folding.h"
#include "../include/narsil_segments.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

const uint16_t BOAT[BOAT_LENGTH] = {0x1ECD, 'k', 0x1ECD, 0x0300};
const uint16_t SPEAR[SPEAR_LENGTH] = {0x1ECD, 0x0300, 'k', 0x1ECD, 0x0300};
const uint16_t BOOK[BOOK_LENGTH] = {0x00EC, 'w', 0x00E9};
const uint16_t EACH[EACH_LENGTH] = {0x1ECD, 0x0300, 'k', 0x1ECD, 0x0300, 0x1ECD, 0x0300, 'k', 'a', 'n'};
const uint16_t BEAN_CAKE[BEAN_CAKE_LENGTH] = {0x00E0, 'k', 0x00E0, 'r', 0x00E0};

static const char YORUBA[] = "yoruba";

narsil_status folded_segment_index(narsil_workspace *workspace, folded_segment *segment, uint32_t ordinal,
                                   const uint16_t *word, uint32_t length) {
  narsil_token token = {0, 0, length, NARSIL_NO_SURFACE, 0, 0, 0, NARSIL_NO_TERM_SLOT};
  narsil_field_tokens field = {0, {&token, 1, word, length}};
  narsil_index_terms_request request = {&segment->data->segment, ordinal, &field, 1};
  return narsil_index_terms(workspace, &request);
}

static narsil_status index_documents(folded_segment *segment) {
  const uint16_t *const words[FOLDED_DOCUMENTS] = {BOAT, BOAT, SPEAR, BOOK, EACH};
  const uint32_t lengths[FOLDED_DOCUMENTS] = {BOAT_LENGTH, BOAT_LENGTH, SPEAR_LENGTH, BOOK_LENGTH, EACH_LENGTH};
  narsil_workspace *workspace = NULL;
  narsil_status status = narsil_workspace_create(&workspace);
  for (uint32_t ordinal = 0; status == NARSIL_OK && ordinal < FOLDED_DOCUMENTS; ordinal++) {
    status = folded_segment_index(workspace, segment, ordinal, words[ordinal], lengths[ordinal]);
  }
  narsil_workspace_destroy(workspace);
  return status;
}

void folded_segment_release(folded_segment *segment) {
  if (segment == NULL) { return; }
  narsil_fold_table_destroy(segment->table);
  narsil_analyser_destroy(segment->analyser);
  free(segment->data);
  free(segment);
}

folded_segment *folded_segment_create(void) {
  folded_segment *segment = calloc(1, sizeof *segment);
  if (segment == NULL) { return NULL; }
  segment->data = create_segment_fixture();
  if (segment->data == NULL || narsil_analyser_create(&segment->analyser) != NARSIL_OK ||
      narsil_fold_table_create(&segment->table) != NARSIL_OK ||
      narsil_language_lookup(YORUBA, sizeof YORUBA - 1, &segment->language) != NARSIL_OK ||
      index_documents(segment) != NARSIL_OK) {
    folded_segment_release(segment);
    return NULL;
  }
  segment->source = (narsil_expansion_segment){.growing = &segment->data->segment};
  return segment;
}

narsil_status folded_segment_update(narsil_workspace *workspace, folded_segment *segment) {
  return narsil_fold_table_update(workspace, segment->analyser, segment->table, &segment->source, segment->language);
}

narsil_status folded_text_of(folded_segment *segment, const uint16_t *units, uint32_t length, uint32_t flags,
                             folded_text *text) {
  text->length = 0;
  narsil_term term = {NULL, 0};
  narsil_status status = narsil_fold_spelling(segment->analyser, segment->language, units, length, flags, &term);
  if (status != NARSIL_OK) { return status; }
  if (term.length > FOLDED_KEY_ROOM) { return NARSIL_NEEDS_ROOM; }
  memcpy(text->units, term.units, term.length * sizeof *term.units);
  text->length = term.length;
  return NARSIL_OK;
}

narsil_status folded_terms(narsil_workspace *workspace, folded_segment *segment, const narsil_folded_word *word,
                           folded_answer *answer) {
  const narsil_fold_table *const tables[] = {segment->table};
  narsil_folded_request request = {&segment->source, tables, 1, word, 1};
  narsil_folded_output output = {answer->segments, FOLDED_ROOM,    answer->tokens,
                                 FOLDED_ROOM,      answer->starts, FOLDED_ROOM};
  answer->count = UINT32_MAX;
  return narsil_expand_folded_terms(workspace, &request, &output, &answer->count);
}

narsil_status folded_prefix(narsil_workspace *workspace, folded_segment *segment, const uint16_t *typed,
                            uint32_t length, folded_answer *answer) {
  const narsil_fold_table *const tables[] = {segment->table};
  folded_text folded;
  answer->count = UINT32_MAX;
  narsil_status status = folded_text_of(segment, typed, length, 0, &folded);
  if (status != NARSIL_OK) { return status; }
  narsil_folded_prefix_request request = {
      {&segment->source, 1, typed, length, typed, length, typed, length}, tables, folded.units, folded.length};
  narsil_expansion_output output = {answer->segments, FOLDED_ROOM,     answer->tokens,
                                    FOLDED_ROOM,      answer->factors, FOLDED_ROOM};
  answer->count = UINT32_MAX;
  return narsil_expand_folded_prefix(workspace, &request, &output, &answer->count);
}

narsil_status folded_partial(narsil_workspace *workspace, folded_segment *segment, const narsil_partial_word *word,
                             folded_answer *answer) {
  const narsil_fold_table *const tables[] = {segment->table};
  narsil_frozen_runs runs = {0};
  folded_text folded;
  answer->count = UINT32_MAX;
  narsil_status status = folded_text_of(segment, word->written, (uint32_t)word->written_length, 0, &folded);
  if (status != NARSIL_OK) { return status; }
  narsil_term probe = {folded.units, folded.length};
  narsil_folded_partial_request request = {{&segment->source, &runs, 1, word, 1}, tables, &probe};
  narsil_partial_output output = {
      {answer->segments, FOLDED_ROOM, answer->tokens, FOLDED_ROOM, answer->factors, FOLDED_ROOM},
      answer->starts,
      FOLDED_ROOM};
  answer->count = UINT32_MAX;
  return narsil_expand_folded_partial_words(workspace, &request, &output, &answer->count);
}
