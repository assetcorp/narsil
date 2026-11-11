#include "input.h"

#include "../include/narsil_analysis.h"
#include "../include/narsil_core.h"
#include "../include/narsil_highlight.h"
#include "../include/narsil_packed_tokens.h"

#include <stddef.h>
#include <stdint.h>

enum {
  MAX_TEXT_UNITS = 2048,
  MAX_STOP_WORDS = 8,
  MAX_STOP_WORD_UNITS = 128,
  MAX_QUERY_TERMS = 4,
  MAX_QUERY_UNITS = 24,
  MAX_TAG_UNITS = 4,
  MAX_SNIPPET_UNITS = 4096,
  MAX_POSITION_WORDS = 64,
  MAX_PACKED_TOKENS = 32,
  MAX_PACKED_WORDS = 512,
  MAX_LANGUAGE_NAME_BYTES = 24,
  PAST_LAST_LANGUAGE = 2
};

static void name_language(fuzz_input *input, uint32_t language) {
  size_t length = fuzz_below(input, MAX_LANGUAGE_NAME_BYTES + 1);
  char *name = FUZZ_ARRAY(input, char, length);
  const char *known = narsil_language_name(language);
  for (size_t at = 0; name != NULL && known != NULL && !fuzz_raw(input) && at < length && known[at] != '\0'; at++) {
    name[at] = known[at];
  }
  uint32_t found = 0;
  (void)narsil_language_lookup(name, length, &found);
}

static void describe_language(fuzz_input *input) {
  uint32_t language =
      fuzz_raw(input) ? fuzz_u32(input) : fuzz_below(input, narsil_language_count() + PAST_LAST_LANGUAGE);
  name_language(input, language);
  (void)narsil_language_revision(language);
  narsil_word_list words = {NULL, NULL, 0};
  (void)narsil_language_stop_words(language, &words);
}

static narsil_analyser *shared_analyser(void) {
  static narsil_analyser *analyser = NULL;
  if (analyser == NULL && narsil_analyser_create(&analyser) != NARSIL_OK) { analyser = NULL; }
  return analyser;
}

static narsil_highlight_text fuzz_text(fuzz_input *input, uint32_t limit) {
  size_t length = fuzz_below(input, limit + 1);
  return (narsil_highlight_text){FUZZ_ARRAY(input, uint16_t, length), length};
}

static narsil_stop_word_set *fuzz_stop_words(fuzz_input *input) {
  uint32_t count = fuzz_below(input, MAX_STOP_WORDS + 1);
  uint32_t *offsets = FUZZ_ARRAY(input, uint32_t, (size_t)count + 1);
  if (offsets == NULL) { return NULL; }
  for (uint32_t at = 0; at <= count && (fuzz_byte(input) & 1U) == 0; at++) { offsets[at] %= MAX_STOP_WORD_UNITS + 1; }
  offsets[count] %= MAX_STOP_WORD_UNITS + 1;
  uint16_t *units = FUZZ_ARRAY(input, uint16_t, offsets[count]);
  narsil_stop_word_set *set = NULL;
  if (narsil_stop_word_set_create(units, offsets, count, &set) != NARSIL_OK) { set = NULL; }
  return set;
}

static void highlight(narsil_analyser *analyser, narsil_workspace *workspace, fuzz_input *input,
                      narsil_analysis_request analysis) {
  size_t term_count = fuzz_below(input, MAX_QUERY_TERMS + 1);
  narsil_highlight_term *terms = FUZZ_ROOM(input, narsil_highlight_term, term_count);
  for (size_t at = 0; terms != NULL && at < term_count; at++) {
    terms[at] = (narsil_highlight_term){fuzz_text(input, MAX_QUERY_UNITS), fuzz_byte(input)};
  }
  size_t synonym_count = fuzz_below(input, MAX_QUERY_TERMS + 1);
  narsil_highlight_text *synonyms = FUZZ_ROOM(input, narsil_highlight_text, synonym_count);
  for (size_t at = 0; synonyms != NULL && at < synonym_count; at++) {
    synonyms[at] = fuzz_text(input, MAX_QUERY_UNITS);
  }
  size_t partial_count = fuzz_below(input, MAX_QUERY_TERMS + 1);
  narsil_highlight_text *partials = FUZZ_ROOM(input, narsil_highlight_text, partial_count);
  for (size_t at = 0; partials != NULL && at < partial_count; at++) {
    partials[at] = fuzz_text(input, MAX_QUERY_UNITS);
  }
  narsil_highlight_query query = {terms,    term_count,    fuzz_u32(input), fuzz_text(input, MAX_QUERY_UNITS),
                                  synonyms, synonym_count, partials,        partial_count};
  narsil_highlight_request request = {analysis.language,
                                      {analysis.text, analysis.length},
                                      query,
                                      fuzz_text(input, MAX_TAG_UNITS),
                                      fuzz_text(input, MAX_TAG_UNITS),
                                      fuzz_u32(input)};
  size_t snippet_capacity = fuzz_below(input, MAX_SNIPPET_UNITS + 1);
  size_t position_words = fuzz_below(input, MAX_POSITION_WORDS + 1);
  narsil_highlight_output output = {FUZZ_ROOM(input, uint16_t, snippet_capacity),
                                    snippet_capacity,
                                    FUZZ_ROOM(input, uint32_t, position_words),
                                    position_words,
                                    FUZZ_ROOM(input, uint32_t, 1),
                                    1};
  uint32_t count = 0;
  if (!input->exhausted_memory) { (void)narsil_highlight(analyser, workspace, &request, &output, &count); }
}

static void pack(fuzz_input *input, const narsil_tokens *analysed) {
  narsil_tokens tokens = *analysed;
  if ((fuzz_byte(input) & 1U) != 0) {
    uint32_t token_count = fuzz_below(input, MAX_PACKED_TOKENS + 1);
    uint32_t unit_count = fuzz_below(input, MAX_TEXT_UNITS + 1);
    tokens = (narsil_tokens){FUZZ_ARRAY(input, narsil_token, token_count), token_count,
                             FUZZ_ARRAY(input, uint16_t, unit_count), unit_count};
  }
  size_t capacity = fuzz_below(input, MAX_PACKED_WORDS + 1);
  size_t unit_capacity = fuzz_below(input, MAX_TEXT_UNITS + 1);
  uint32_t *records = FUZZ_ROOM(input, uint32_t, capacity);
  uint16_t *units = FUZZ_ROOM(input, uint16_t, unit_capacity);
  uint32_t unit_count = 0;
  if (!input->exhausted_memory) {
    (void)narsil_pack_tokens(&tokens, records, capacity, units, unit_capacity, &unit_count);
  }
}

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
  narsil_analyser *analyser = shared_analyser();
  narsil_workspace *workspace = NULL;
  if (analyser == NULL || narsil_workspace_create(&workspace) != NARSIL_OK) { return 0; }
  fuzz_input input = fuzz_begin(data, size);
  describe_language(&input);
  narsil_stop_word_set *stop_words = fuzz_stop_words(&input);
  uint32_t language = fuzz_below(&input, narsil_language_count() + 2);
  uint32_t flags = fuzz_u32(&input);
  uint32_t length = fuzz_below(&input, MAX_TEXT_UNITS + 1);
  const uint16_t *text = FUZZ_ARRAY(&input, uint16_t, length);
  narsil_analysis_request analysis = {language, stop_words, flags, text, length};
  narsil_tokens tokens = {NULL, 0, NULL, 0};
  if (narsil_analyse(analyser, &analysis, &tokens) != NARSIL_OK) { tokens = (narsil_tokens){NULL, 0, NULL, 0}; }
  pack(&input, &tokens);
  narsil_term term = {NULL, 0};
  analysis.flags = fuzz_u32(&input);
  (void)narsil_transform(analyser, &analysis, &term);
  highlight(analyser, workspace, &input, analysis);
  narsil_stop_word_set_destroy(stop_words);
  narsil_workspace_destroy(workspace);
  fuzz_release(&input);
  return 0;
}
