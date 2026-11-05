#include "../../include/narsil_analysis.h"
#include "../../include/narsil_core.h"
#include "../languages/snowball/api.h"
#include "analyser.h"
#include "languages.h"
#include "normalise.h"
#include "split.h"
#include "stop_words.h"
#include "term_cache.h"
#include "text.h"
#include "unicode.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define APOSTROPHE 0x27U
#define LATIN_SMALL_S 0x73U
#define MIN_TOKEN_CAPACITY 32U

narsil_status narsil_analyser_create(narsil_analyser **analyser) {
  if (analyser == NULL) { return NARSIL_INVALID_ARGUMENT; }
  *analyser = NULL;
  if (narsil_unicode_prepare() != NARSIL_OK) { return NARSIL_OUT_OF_MEMORY; }
  narsil_analyser *created = calloc(1, sizeof(narsil_analyser));
  if (created == NULL) { return NARSIL_OUT_OF_MEMORY; }
  created->snowball = (struct SN_env **)calloc(narsil_language_table_length, sizeof(struct SN_env *));
  created->default_stop_words = calloc(narsil_language_table_length, sizeof(narsil_stop_words));
  created->default_stop_words_built = calloc(narsil_language_table_length, sizeof(uint8_t));
  if (created->snowball == NULL || created->default_stop_words == NULL || created->default_stop_words_built == NULL) {
    narsil_analyser_destroy(created);
    return NARSIL_OUT_OF_MEMORY;
  }
  *analyser = created;
  return NARSIL_OK;
}

void narsil_analyser_destroy(narsil_analyser *analyser) {
  if (analyser == NULL) { return; }
  for (uint32_t language = 0; language < narsil_language_table_length; language++) {
    if (analyser->snowball != NULL && analyser->snowball[language] != NULL) {
      narsil_language_table[language]->close_snowball(analyser->snowball[language]);
    }
    if (analyser->default_stop_words != NULL) { narsil_stop_words_release(&analyser->default_stop_words[language]); }
  }
  free((void *)analyser->snowball);
  free(analyser->default_stop_words);
  free(analyser->default_stop_words_built);
  narsil_normalise_scratch_release(&analyser->scratch);
  narsil_text_release(&analyser->folded);
  narsil_spans_release(&analyser->parts);
  narsil_spans_release(&analyser->grams);
  narsil_code_points_release(&analyser->gram_offsets);
  narsil_text_release(&analyser->step_a);
  narsil_text_release(&analyser->step_b);
  narsil_text_release(&analyser->surface_step);
  narsil_text_release(&analyser->surface);
  narsil_text_release(&analyser->arena);
  narsil_term_cache_release(&analyser->terms);
  free(analyser->tokens);
  free(analyser);
}

narsil_status narsil_stop_word_set_create(const uint16_t *units, const uint32_t *offsets, uint32_t count,
                                          narsil_stop_word_set **set) {
  if (set == NULL || offsets == NULL || (units == NULL && offsets[count] > offsets[0])) {
    return NARSIL_INVALID_ARGUMENT;
  }
  *set = NULL;
  narsil_stop_word_set *created = calloc(1, sizeof(narsil_stop_word_set));
  if (created == NULL) { return NARSIL_OUT_OF_MEMORY; }
  int status = narsil_stop_words_build(&created->words, units, offsets, count);
  if (status != NARSIL_OK) {
    free(created);
    return (narsil_status)status;
  }
  *set = created;
  return NARSIL_OK;
}

void narsil_stop_word_set_destroy(narsil_stop_word_set *set) {
  if (set == NULL) { return; }
  narsil_stop_words_release(&set->words);
  free(set);
}

static const narsil_stop_words *stop_words_for(narsil_analyser *analyser, const narsil_analysis_request *request,
                                               int *status) {
  *status = NARSIL_OK;
  if ((request->flags & NARSIL_ANALYSE_REMOVE_STOP_WORDS) == 0) { return NULL; }
  if (request->stop_words != NULL) { return &request->stop_words->words; }
  uint32_t index = request->language;
  if (!analyser->default_stop_words_built[index]) {
    const narsil_language *language = narsil_language_table[index];
    *status = narsil_stop_words_build(&analyser->default_stop_words[index], language->stop_word_units,
                                      language->stop_word_offsets, language->stop_word_count);
    if (*status != NARSIL_OK) { return NULL; }
    analyser->default_stop_words_built[index] = 1;
  }
  return &analyser->default_stop_words[index];
}

static narsil_unit_view strip_possessive(narsil_unit_view part) {
  const uint16_t *units = part.units;
  size_t length = part.length;
  if (length >= 2 && units[length - 1] == LATIN_SMALL_S && units[length - 2] == APOSTROPHE) {
    part.length -= 2;
  } else if (length >= 1 && units[length - 1] == APOSTROPHE) {
    part.length -= 1;
  }
  return part;
}

static int append_units(narsil_analyser *analyser, narsil_unit_view view, uint32_t *offset) {
  if (analyser->arena.length + view.length > UINT32_MAX) { return NARSIL_INVALID_ARGUMENT; }
  *offset = (uint32_t)analyser->arena.length;
  return narsil_text_append(&analyser->arena, view.units, view.length);
}

static int push_token(narsil_analyser *analyser, uint32_t position, narsil_span original, narsil_unit_view term,
                      uint32_t term_slot, const narsil_unit_view *surface) {
  if (analyser->token_count == analyser->token_capacity) {
    uint32_t capacity = analyser->token_capacity < MIN_TOKEN_CAPACITY ? MIN_TOKEN_CAPACITY : analyser->token_capacity;
    if (analyser->token_count == capacity) {
      if (capacity > UINT32_MAX / 2) { return NARSIL_OUT_OF_MEMORY; }
      capacity *= 2;
    }
    narsil_token *grown = realloc(analyser->tokens, (size_t)capacity * sizeof(narsil_token));
    if (grown == NULL) { return NARSIL_OUT_OF_MEMORY; }
    analyser->tokens = grown;
    analyser->token_capacity = capacity;
  }
  narsil_token *token = &analyser->tokens[analyser->token_count];
  token->position = position;
  token->original_offset = original.start;
  token->original_length = original.length;
  token->surface_offset = NARSIL_NO_SURFACE;
  token->surface_length = 0;
  token->term_length = (uint32_t)term.length;
  token->term_slot = term_slot;
  int status = append_units(analyser, term, &token->term_offset);
  if (status == NARSIL_OK && surface != NULL) {
    token->surface_length = (uint32_t)surface->length;
    status = append_units(analyser, *surface, &token->surface_offset);
  }
  if (status == NARSIL_OK) { analyser->token_count++; }
  return status;
}

static int validate(const narsil_analyser *analyser, const narsil_analysis_request *request,
                    const narsil_tokens *tokens) {
  if (analyser == NULL || request == NULL || tokens == NULL) { return NARSIL_INVALID_ARGUMENT; }
  if (request->language >= narsil_language_table_length) { return NARSIL_INVALID_ARGUMENT; }
  if ((request->flags & ~NARSIL_ANALYSE_FLAGS) != 0 && request->flags != NARSIL_ANALYSE_SPELLINGS) {
    return NARSIL_INVALID_ARGUMENT;
  }
  if (request->length > NARSIL_MAX_ANALYSED_UNITS || (request->text == NULL && request->length > 0)) {
    return NARSIL_INVALID_ARGUMENT;
  }
  return NARSIL_OK;
}

typedef struct {
  const narsil_language *language;
  uint32_t language_index;
  const narsil_stop_words *stop_words;
  uint32_t flags;
} analysis_pass;

static int push_spelling(narsil_analyser *analyser, const analysis_pass *pass, uint32_t position, narsil_span part,
                         narsil_unit_view candidate) {
  narsil_unit_view spelling = candidate;
  uint32_t term_slot = NARSIL_NO_TERM_SLOT;
  if (pass->language->normalises_diacritics) {
    int status = narsil_transform_token(analyser, pass->language, pass->language_index, candidate,
                                        NARSIL_ANALYSE_REMOVE_DIACRITICS, &spelling, &term_slot);
    if (status != NARSIL_OK) { return status; }
  }
  return push_token(analyser, position, part, spelling, term_slot, NULL);
}

static int analyse_part(narsil_analyser *analyser, const analysis_pass *pass, uint32_t position, narsil_span part) {
  const narsil_language *language = pass->language;
  narsil_unit_view candidate = {analyser->folded.units + part.start, part.length};
  if (language->strips_possessive) { candidate = strip_possessive(candidate); }
  if (candidate.length < language->min_token_length) { return NARSIL_OK; }
  if ((pass->flags & NARSIL_ANALYSE_SPELLINGS) != 0) {
    return push_spelling(analyser, pass, position, part, candidate);
  }
  if (pass->stop_words != NULL && narsil_stop_words_contains(pass->stop_words, candidate.units, candidate.length)) {
    return NARSIL_OK;
  }
  narsil_unit_view term;
  uint32_t term_slot = NARSIL_NO_TERM_SLOT;
  int status =
      narsil_transform_token(analyser, language, pass->language_index, candidate, pass->flags, &term, &term_slot);
  if (status != NARSIL_OK || term.length == 0) { return status; }
  int stems =
      (pass->flags & NARSIL_ANALYSE_STEM) != 0 && (language->stem_by_rules != NULL || language->snowball_stem != NULL);
  if ((pass->flags & NARSIL_ANALYSE_COLLECT_SURFACES) == 0 || !stems) {
    return push_token(analyser, position, part, term, term_slot, NULL);
  }
  narsil_unit_view surface = candidate;
  if ((pass->flags & NARSIL_ANALYSE_REMOVE_DIACRITICS) != 0) {
    status = narsil_surface_of(analyser, language, candidate, &surface);
    if (status != NARSIL_OK) { return status; }
  }
  int same = narsil_units_equal(surface.units, surface.length, term.units, term.length);
  return push_token(analyser, position, part, term, term_slot, same ? NULL : &surface);
}

static int split_text(narsil_analyser *analyser, const narsil_language *language, const narsil_spans **parts) {
  int status = narsil_split(language, analyser->folded.units, (uint32_t)analyser->folded.length, &analyser->parts);
  *parts = &analyser->parts;
  if (status != NARSIL_OK || language->ngram_size < 1) { return status; }
  analyser->grams.length = 0;
  for (size_t i = 0; i < analyser->parts.length && status == NARSIL_OK; i++) {
    status = narsil_expand_ngrams(analyser->folded.units, analyser->parts.spans[i], language->ngram_size,
                                  &analyser->grams, &analyser->gram_offsets);
  }
  *parts = &analyser->grams;
  return status;
}

narsil_status narsil_transform(narsil_analyser *analyser, const narsil_analysis_request *request, narsil_term *term) {
  if (analyser == NULL || request == NULL || term == NULL) { return NARSIL_INVALID_ARGUMENT; }
  if (request->language >= narsil_language_table_length || (request->flags & ~NARSIL_TRANSFORM_FLAGS) != 0) {
    return NARSIL_INVALID_ARGUMENT;
  }
  if (request->length > NARSIL_MAX_ANALYSED_UNITS || (request->text == NULL && request->length > 0)) {
    return NARSIL_INVALID_ARGUMENT;
  }
  static const uint16_t no_units[1] = {0};
  narsil_unit_view candidate = {request->length == 0 ? no_units : request->text, request->length};
  narsil_unit_view result = candidate;
  uint32_t term_slot = NARSIL_NO_TERM_SLOT;
  int status = narsil_transform_token(analyser, narsil_language_table[request->language], request->language, candidate,
                                      request->flags, &result, &term_slot);
  if (status != NARSIL_OK) { return (narsil_status)status; }
  if (result.length > NARSIL_MAX_ANALYSED_UNITS) { return NARSIL_INVALID_ARGUMENT; }
  term->units = result.units;
  term->length = (uint32_t)result.length;
  return NARSIL_OK;
}

narsil_status narsil_analyse(narsil_analyser *analyser, const narsil_analysis_request *request, narsil_tokens *tokens) {
  int status = validate(analyser, request, tokens);
  if (status != NARSIL_OK) { return (narsil_status)status; }
  const narsil_language *language = narsil_language_table[request->language];
  analyser->token_count = 0;
  analyser->arena.length = 0;
  memset(tokens, 0, sizeof(*tokens));
  status = narsil_text_reserve(&analyser->folded, 1);
  if (status == NARSIL_OK) { status = narsil_text_reserve(&analyser->arena, 1); }
  if (status != NARSIL_OK) { return (narsil_status)status; }
  status = narsil_fold_for_splitting(request->text, request->length, &analyser->folded, &analyser->scratch);
  if (status == NARSIL_OK && analyser->folded.length > NARSIL_MAX_ANALYSED_UNITS) { status = NARSIL_INVALID_ARGUMENT; }
  if (status == NARSIL_OK) {
    status = narsil_text_assign(&analyser->arena, analyser->folded.units, analyser->folded.length);
  }
  const narsil_spans *parts = NULL;
  if (status == NARSIL_OK) { status = split_text(analyser, language, &parts); }
  analysis_pass pass = {language, request->language, NULL, request->flags};
  if (status == NARSIL_OK) { pass.stop_words = stop_words_for(analyser, request, &status); }
  if (language->normalises_diacritics) { pass.flags |= NARSIL_ANALYSE_REMOVE_DIACRITICS; }
  for (size_t position = 0; status == NARSIL_OK && parts != NULL && position < parts->length; position++) {
    status = analyse_part(analyser, &pass, (uint32_t)position, parts->spans[position]);
  }
  if (status != NARSIL_OK) {
    analyser->token_count = 0;
    return (narsil_status)status;
  }
  tokens->tokens = analyser->tokens;
  tokens->token_count = analyser->token_count;
  tokens->units = analyser->arena.units;
  tokens->unit_count = (uint32_t)analyser->arena.length;
  return NARSIL_OK;
}
