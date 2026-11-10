#include "allocation_failures.h"

#include "../include/narsil_analysis.h"
#include "../include/narsil_core.h"
#include "../include/narsil_highlight.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define TEXT_REPEATS 24U
#define TEXT_UNITS 4096U
#define SNIPPET_UNITS 8192U
#define HIGHLIGHT_POSITIONS 2048U
#define LANGUAGE_NAME "english"
#define ANALYSIS_FLAGS NARSIL_ANALYSE_FLAGS
#define E_ACUTE 0x00E9U
#define COMBINING_ACUTE 0x0301U
#define HIGH_SURROGATE 0xD83DU
#define LOW_SURROGATE 0xDE00U

static const char *const WORDS[] = {"the",
                                    "running",
                                    "runners",
                                    "and",
                                    "internationalisationalisms",
                                    "pneumonoultramicroscopicsilicovolcanoconiosis",
                                    "caf",
                                    "nations",
                                    "it's",
                                    "quickly",
                                    "of",
                                    "connected"};

typedef struct {
  narsil_analyser *analyser;
  narsil_stop_word_set *stop_words;
  uint32_t language;
  uint16_t text[TEXT_UNITS];
  uint32_t length;
  uint64_t digest;
} analysis_inputs;

static void append_word(analysis_inputs *inputs, const char *word, size_t index) {
  for (size_t at = 0; word[at] != '\0' && inputs->length < TEXT_UNITS; at++) {
    inputs->text[inputs->length++] = (uint16_t)(unsigned char)word[at];
  }
  if (strcmp(word, "caf") == 0 && inputs->length < TEXT_UNITS - 2) {
    inputs->text[inputs->length++] = index % 2 == 0 ? E_ACUTE : 'e';
    if (index % 2 != 0) { inputs->text[inputs->length++] = COMBINING_ACUTE; }
  }
  if (index % (sizeof WORDS / sizeof WORDS[0]) == 0 && inputs->length < TEXT_UNITS - 2) {
    inputs->text[inputs->length++] = HIGH_SURROGATE;
    inputs->text[inputs->length++] = LOW_SURROGATE;
  }
  if (inputs->length < TEXT_UNITS) { inputs->text[inputs->length++] = ' '; }
}

static analysis_inputs *analysis_text(void) {
  analysis_inputs *inputs = calloc(1, sizeof *inputs);
  if (inputs == NULL) { return NULL; }
  if (narsil_language_lookup(LANGUAGE_NAME, sizeof LANGUAGE_NAME - 1, &inputs->language) != NARSIL_OK) {
    free(inputs);
    return NULL;
  }
  size_t word_count = sizeof WORDS / sizeof WORDS[0];
  for (size_t repeat = 0; repeat < TEXT_REPEATS; repeat++) {
    for (size_t word = 0; word < word_count; word++) { append_word(inputs, WORDS[word], (repeat * word_count) + word); }
  }
  return inputs;
}

static void *prepare_analysis(void) {
  analysis_inputs *inputs = analysis_text();
  if (inputs == NULL) { return NULL; }
  if (narsil_analyser_create(&inputs->analyser) != NARSIL_OK) {
    free(inputs);
    return NULL;
  }
  return inputs;
}

static void release_analysis(void *opaque) {
  analysis_inputs *inputs = opaque;
  narsil_stop_word_set_destroy(inputs->stop_words);
  narsil_analyser_destroy(inputs->analyser);
  free(inputs);
}

static uint64_t digest_of_analysis(const void *opaque) {
  const analysis_inputs *inputs = opaque;
  return inputs->digest;
}

static uint64_t digest_tokens(const narsil_tokens *tokens) {
  uint64_t digest = digest_word(DIGEST_START, tokens->token_count);
  for (uint32_t index = 0; index < tokens->token_count; index++) {
    const narsil_token *token = &tokens->tokens[index];
    digest = digest_word(digest, token->position);
    digest = digest_word(digest, token->original_offset);
    digest = digest_word(digest, token->original_length);
    digest = digest_bytes(digest, tokens->units + token->term_offset, token->term_length * sizeof(uint16_t));
    digest = digest_word(digest, token->surface_offset == NARSIL_NO_SURFACE);
    if (token->surface_offset != NARSIL_NO_SURFACE) {
      digest = digest_bytes(digest, tokens->units + token->surface_offset, token->surface_length * sizeof(uint16_t));
    }
  }
  return digest;
}

static narsil_status analyse_into(analysis_inputs *inputs, uint32_t flags) {
  narsil_analysis_request request = {inputs->language, inputs->stop_words, flags, inputs->text, inputs->length};
  narsil_tokens tokens = {NULL, 0, NULL, 0};
  narsil_status status = narsil_analyse(inputs->analyser, &request, &tokens);
  inputs->digest = status == NARSIL_OK ? digest_tokens(&tokens) : 0;
  return status;
}

static narsil_status analyse_every_feature(narsil_workspace *workspace, void *opaque) {
  (void)workspace;
  return analyse_into(opaque, ANALYSIS_FLAGS);
}

static narsil_status analyse_spellings(narsil_workspace *workspace, void *opaque) {
  (void)workspace;
  return analyse_into(opaque, NARSIL_ANALYSE_SPELLINGS);
}

static void *prepare_text(void) { return analysis_text(); }

static narsil_status create_then_analyse(narsil_workspace *workspace, void *opaque) {
  (void)workspace;
  analysis_inputs *inputs = opaque;
  narsil_analyser_destroy(inputs->analyser);
  inputs->analyser = NULL;
  narsil_status status = narsil_analyser_create(&inputs->analyser);
  return status == NARSIL_OK ? analyse_into(inputs, ANALYSIS_FLAGS) : status;
}

static narsil_status custom_stop_words(narsil_workspace *workspace, void *opaque) {
  (void)workspace;
  analysis_inputs *inputs = opaque;
  static const uint16_t units[] = {'r', 'u', 'n', 'n', 'i', 'n', 'g', 'q', 'u', 'i', 'c', 'k', 'l', 'y'};
  static const uint32_t offsets[] = {0, 7, 14};
  narsil_stop_word_set_destroy(inputs->stop_words);
  inputs->stop_words = NULL;
  narsil_status status =
      narsil_stop_word_set_create(units, offsets, (sizeof offsets / sizeof offsets[0]) - 1, &inputs->stop_words);
  return status == NARSIL_OK ? analyse_into(inputs, ANALYSIS_FLAGS) : status;
}

static narsil_status transform_one_word(narsil_workspace *workspace, void *opaque) {
  (void)workspace;
  analysis_inputs *inputs = opaque;
  static const uint16_t word[] = {'n', 'a', 't', 'i', 'o', 'n', 'a', 'l', 'i', 's', 'a', 't', 'i', 'o',
                                  'n', 'a', 'l', 'i', 's', 'a', 't', 'i', 'o', 'n', 's', 'm', 's', E_ACUTE};
  narsil_analysis_request request = {inputs->language, NULL, NARSIL_TRANSFORM_FLAGS, word,
                                     sizeof word / sizeof word[0]};
  narsil_term term = {NULL, 0};
  narsil_status status = narsil_transform(inputs->analyser, &request, &term);
  inputs->digest = status == NARSIL_OK ? digest_bytes(DIGEST_START, term.units, term.length * sizeof(uint16_t)) : 0;
  return status;
}

static narsil_status highlight_text(narsil_workspace *workspace, void *opaque) {
  analysis_inputs *inputs = opaque;
  static const uint16_t run[] = {'r', 'u', 'n'};
  static const uint16_t nation[] = {'n', 'a', 't', 'i', 'o', 'n'};
  static const uint16_t prefix[] = {'c', 'o', 'n'};
  static const uint16_t partial[] = {'i', 'c', 'k'};
  static const uint16_t before[] = {'<', 'b', '>'};
  static const uint16_t after[] = {'<', '/', 'b', '>'};
  narsil_highlight_term terms[] = {{{run, sizeof run / sizeof run[0]}, 0},
                                   {{nation, sizeof nation / sizeof nation[0]}, 1}};
  narsil_highlight_text synonyms[] = {{prefix, sizeof prefix / sizeof prefix[0]}};
  narsil_highlight_text partial_words[] = {{partial, sizeof partial / sizeof partial[0]}};
  narsil_highlight_query query = {
      terms, sizeof terms / sizeof terms[0], 1, {prefix, sizeof prefix / sizeof prefix[0]}, synonyms, 1, partial_words,
      1};
  narsil_highlight_request request = {inputs->language,
                                      {inputs->text, inputs->length},
                                      query,
                                      {before, sizeof before / sizeof before[0]},
                                      {after, sizeof after / sizeof after[0]},
                                      0};
  static uint16_t snippet[SNIPPET_UNITS];
  static uint32_t positions[HIGHLIGHT_POSITIONS];
  uint32_t length = 0;
  uint32_t count = 0;
  narsil_highlight_output output = {snippet, SNIPPET_UNITS, positions, HIGHLIGHT_POSITIONS, &length, 1};
  narsil_status status = narsil_highlight(inputs->analyser, workspace, &request, &output, &count);
  inputs->digest = 0;
  if (status == NARSIL_OK) {
    inputs->digest = digest_bytes(digest_word(DIGEST_START, count), snippet, length * sizeof(uint16_t));
    inputs->digest = digest_bytes(inputs->digest, positions, (size_t)count * 2 * sizeof(uint32_t));
  }
  return status;
}

void analysis_allocation_failures(void) {
  const failing_call calls[] = {
      {"analysis with every feature", prepare_analysis, analyse_every_feature, digest_of_analysis, release_analysis},
      {"analysis of spellings", prepare_analysis, analyse_spellings, digest_of_analysis, release_analysis},
      {"a new analyser", prepare_text, create_then_analyse, digest_of_analysis, release_analysis},
      {"a custom stop word set", prepare_analysis, custom_stop_words, digest_of_analysis, release_analysis},
      {"a transformed word", prepare_analysis, transform_one_word, digest_of_analysis, release_analysis},
      {"a highlighted text", prepare_analysis, highlight_text, digest_of_analysis, release_analysis},
  };
  for (size_t at = 0; at < sizeof calls / sizeof calls[0]; at++) { refuse_each_allocation(&calls[at]); }
}
