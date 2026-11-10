#include "terms.h"

#include "input.h"
#include "segment.h"

#include "../include/narsil_core.h"
#include "../include/narsil_expansion.h"
#include "../include/narsil_segment_merge.h"
#include "../include/narsil_suggestions.h"
#include "../include/narsil_terms.h"

#include <stddef.h>
#include <stdint.h>

enum {
  MAX_OUTPUT = 48,
  MAX_BATCH_WORDS = 4,
  MAX_PARTIAL_WORDS = 3,
  LOOKUP_OPERATIONS = NARSIL_LOOKUP_TYPO + 2,
  MAX_TOLERANCE = 3,
  MAX_PREFIX_LENGTH = 4,
  TERM_OFFSET_STRIDE = 1,
  PAIRED_OFFSET_STRIDE = 2
};

void fuzz_lookup(narsil_workspace *workspace, fuzz_input *input, const narsil_term_dictionary *dictionary) {
  size_t length = 0;
  const uint16_t *text = fuzz_word(input, &length);
  narsil_term_lookup request = {dictionary,
                                text,
                                length,
                                fuzz_below(input, LOOKUP_OPERATIONS),
                                fuzz_below(input, MAX_OUTPUT),
                                fuzz_below(input, MAX_TOLERANCE + 1),
                                fuzz_below(input, MAX_PREFIX_LENGTH + 1)};
  size_t capacity = fuzz_count(input, MAX_OUTPUT);
  uint32_t *ordinals = FUZZ_ROOM(input, uint32_t, capacity);
  uint32_t *count = FUZZ_ROOM(input, uint32_t, 1);
  if (input->exhausted_memory) { return; }
  (void)narsil_lookup_terms(workspace, &request, ordinals, capacity, count);
}

void fuzz_exact_batch(narsil_workspace *workspace, fuzz_input *input, const narsil_term_dictionary *dictionary) {
  size_t words = fuzz_count(input, MAX_BATCH_WORDS);
  uint32_t lengths[MAX_BATCH_WORDS] = {0};
  const uint16_t *texts[MAX_BATCH_WORDS] = {NULL};
  size_t unit_count = 0;
  for (size_t at = 0; at < words; at++) {
    size_t length = 0;
    texts[at] = fuzz_word(input, &length);
    lengths[at] = (uint32_t)length;
    unit_count += length;
  }
  uint16_t *units = FUZZ_ROOM(input, uint16_t, unit_count);
  uint32_t *offsets = FUZZ_ROOM(input, uint32_t, words + 1);
  if (input->exhausted_memory) { return; }
  size_t written = 0;
  for (size_t at = 0; at < words; at++) {
    offsets[at] = (uint32_t)written;
    for (size_t unit = 0; unit < lengths[at]; unit++) { units[written++] = texts[at][unit]; }
  }
  offsets[words] = (uint32_t)written;
  fuzz_disturb(input, offsets, (words + 1) * sizeof *offsets);
  size_t capacity = fuzz_count(input, MAX_BATCH_WORDS + 1);
  uint32_t *ordinals = FUZZ_ROOM(input, uint32_t, capacity);
  if (input->exhausted_memory) { return; }
  (void)narsil_lookup_exact_batch(workspace, dictionary, units, unit_count, offsets, words + 1, ordinals, capacity);
}

void fuzz_frequency(fuzz_input *input, const narsil_term_dictionary *dictionary, uint32_t token_count) {
  uint32_t token = fuzz_raw(input) ? fuzz_u32(input) : fuzz_below(input, token_count);
  size_t capacity = fuzz_count(input, 1);
  uint32_t *result = FUZZ_ROOM(input, uint32_t, capacity);
  if (input->exhausted_memory) { return; }
  (void)narsil_document_frequency(dictionary, token, result, capacity);
}

static narsil_expansion_output expansion_room(fuzz_input *input) {
  size_t segments = fuzz_count(input, MAX_OUTPUT);
  size_t tokens = fuzz_count(input, MAX_OUTPUT);
  size_t factors = fuzz_count(input, MAX_OUTPUT);
  return (narsil_expansion_output){FUZZ_ROOM(input, uint32_t, segments), segments,
                                   FUZZ_ROOM(input, uint32_t, tokens),   tokens,
                                   FUZZ_ROOM(input, double, factors),    factors};
}

void fuzz_prefix(narsil_workspace *workspace, fuzz_input *input, const narsil_expansion_segment *source) {
  size_t typed = 0;
  size_t stemmed = 0;
  size_t own = 0;
  const uint16_t *typed_units = fuzz_word(input, &typed);
  const uint16_t *stemmed_units = fuzz_word(input, &stemmed);
  const uint16_t *own_units = fuzz_word(input, &own);
  narsil_prefix_request request = {source, 1, typed_units, typed, stemmed_units, stemmed, own_units, own};
  narsil_expansion_output output = expansion_room(input);
  uint32_t *count = FUZZ_ROOM(input, uint32_t, 1);
  if (input->exhausted_memory) { return; }
  (void)narsil_expand_prefix(workspace, &request, &output, count);
}

void fuzz_partial(narsil_workspace *workspace, fuzz_input *input, const narsil_expansion_segment *source,
                  const narsil_frozen_runs *runs) {
  size_t word_count = fuzz_count(input, MAX_PARTIAL_WORDS);
  narsil_partial_word *words = FUZZ_ROOM(input, narsil_partial_word, word_count);
  for (size_t at = 0; words != NULL && at < word_count; at++) {
    size_t written = 0;
    size_t own = 0;
    const uint16_t *written_units = fuzz_word(input, &written);
    const uint16_t *own_units = fuzz_word(input, &own);
    words[at] = (narsil_partial_word){written_units,
                                      written,
                                      own_units,
                                      own,
                                      fuzz_below(input, MAX_TOLERANCE + 1),
                                      fuzz_below(input, MAX_PREFIX_LENGTH + 1)};
  }
  narsil_partial_request request = {source, runs, 1, words, word_count};
  size_t starts = fuzz_count(input, MAX_PARTIAL_WORDS + 2);
  narsil_partial_output output = {expansion_room(input), FUZZ_ROOM(input, uint32_t, starts), starts};
  uint32_t *count = FUZZ_ROOM(input, uint32_t, 1);
  if (input->exhausted_memory) { return; }
  (void)narsil_expand_partial_words(workspace, &request, &output, count);
}

void fuzz_suggest(narsil_workspace *workspace, fuzz_input *input, const narsil_expansion_segment *source) {
  size_t typed = 0;
  size_t stemmed = 0;
  const uint16_t *typed_units = fuzz_word(input, &typed);
  const uint16_t *stemmed_units = fuzz_word(input, &stemmed);
  narsil_suggestion_request request = {
      source, 1, typed_units, typed, stemmed_units, stemmed, fuzz_below(input, MAX_OUTPUT)};
  size_t terms = fuzz_count(input, MAX_OUTPUT) * NARSIL_SUGGESTION_WORDS;
  size_t starts = fuzz_count(input, MAX_OUTPUT);
  size_t spellings = fuzz_count(input, MAX_OUTPUT);
  size_t occurrences = fuzz_count(input, MAX_OUTPUT);
  narsil_suggestion_output output = {
      FUZZ_ROOM(input, uint32_t, terms),     terms,     FUZZ_ROOM(input, uint32_t, starts),    starts,
      FUZZ_ROOM(input, uint32_t, spellings), spellings, FUZZ_ROOM(input, double, occurrences), occurrences};
  uint32_t *count = FUZZ_ROOM(input, uint32_t, 1);
  if (input->exhausted_memory) { return; }
  (void)narsil_suggest_terms(workspace, &request, &output, count);
}

typedef struct {
  uint32_t count;
  uint32_t bytes;
} string_sizes;

static narsil_merged_strings merged_strings(fuzz_input *input, string_sizes sizes, size_t stride) {
  size_t offsets = ((size_t)sizes.count * stride) + 1;
  return (narsil_merged_strings){FUZZ_ROOM(input, uint8_t, sizes.bytes),
                                 FUZZ_ROOM(input, uint32_t, offsets),
                                 FUZZ_ROOM(input, uint32_t, sizes.count),
                                 sizes.count,
                                 sizes.bytes,
                                 offsets};
}

static void write_merge(narsil_workspace *workspace, fuzz_input *input, const narsil_keyword_merge_request *request,
                        const narsil_keyword_merge_sizes *sizes) {
  size_t lengths = (size_t)request->document_count * request->field_count;
  narsil_keyword_merge_output output = {
      merged_strings(input, (string_sizes){sizes->terms, sizes->term_bytes}, TERM_OFFSET_STRIDE),
      FUZZ_ROOM(input, uint32_t, (size_t)sizes->terms + 1),
      (size_t)sizes->terms + 1,
      FUZZ_ROOM(input, uint32_t, sizes->postings),
      FUZZ_ROOM(input, uint16_t, sizes->postings),
      FUZZ_ROOM(input, uint16_t, sizes->postings),
      sizes->postings,
      FUZZ_ROOM(input, uint32_t, (size_t)sizes->postings + 1),
      (size_t)sizes->postings + 1,
      FUZZ_ROOM(input, uint32_t, sizes->positions),
      sizes->positions,
      FUZZ_ROOM(input, uint32_t, lengths),
      lengths,
      FUZZ_ROOM(input, double, request->field_count),
      request->field_count,
      merged_strings(input, (string_sizes){sizes->surfaces, sizes->surface_bytes}, PAIRED_OFFSET_STRIDE),
      merged_strings(input, (string_sizes){sizes->spellings, sizes->spelling_bytes}, PAIRED_OFFSET_STRIDE)};
  if (input->exhausted_memory) { return; }
  (void)narsil_write_merge(workspace, request, &output);
}

void fuzz_merge_into(narsil_workspace *workspace, fuzz_input *input, const narsil_keyword_merge_request *request) {
  narsil_keyword_merge_sizes sizes = {0};
  if (input->exhausted_memory || narsil_measure_merge(workspace, request, &sizes) != NARSIL_OK) { return; }
  write_merge(workspace, input, request, &sizes);
}
