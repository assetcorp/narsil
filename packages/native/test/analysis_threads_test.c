#include "fixture.h"

#ifndef _WIN32

#include "../include/narsil_analysis.h"
#include "../include/narsil_core.h"

#include <pthread.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define ANALYSER_THREADS 4
#define TEXTS 64
#define WORDS_PER_TEXT 400
#define ROUNDS_PER_THREAD 8
#define MAX_SYLLABLES 3
#define LONGEST_WORD_UNITS 16
#define TEXT_UNITS (WORDS_PER_TEXT * (LONGEST_WORD_UNITS + 1))
#define ROUND_STRIDE 7
#define CLOSED_SYLLABLE_ODDS 2
#define FIRST_RANDOM_STATE 2463534242U
#define XORSHIFT_LEFT 13
#define XORSHIFT_RIGHT 17
#define XORSHIFT_LAST_LEFT 5
#define FNV64_OFFSET_BASIS 14695981039346656037ULL
#define FNV64_PRIME 1099511628211ULL
#define ANALYSIS_FLAGS (NARSIL_ANALYSE_STEM | NARSIL_ANALYSE_REMOVE_DIACRITICS | NARSIL_ANALYSE_COLLECT_SURFACES)

static const char ENGLISH[] = "english";
static const char CONSONANTS[] = "bcdfglmnprstv";
static const char VOWELS[] = "aeiou";
static const char *const SUFFIXES[] = {"", "s", "ing", "ed", "ation", "ness", "ly", "er"};

typedef struct {
  uint16_t units[TEXT_UNITS];
  uint32_t length;
} sample_text;

typedef struct {
  const sample_text *texts;
  const uint64_t *expected;
  uint32_t language;
  uint32_t first_text;
  int mismatches;
  narsil_status status;
} analyser_thread;

static uint32_t next_random(uint32_t *state) {
  uint32_t value = *state;
  value ^= value << XORSHIFT_LEFT;
  value ^= value >> XORSHIFT_RIGHT;
  value ^= value << XORSHIFT_LAST_LEFT;
  *state = value;
  return value;
}

static void append_letter(sample_text *text, char letter) { text->units[text->length++] = (uint16_t)letter; }

static void append_letter_of(sample_text *text, const char *letters, size_t count, uint32_t *state) {
  append_letter(text, letters[next_random(state) % count]);
}

static void append_word(sample_text *text, uint32_t *state) {
  uint32_t syllables = 1 + (next_random(state) % MAX_SYLLABLES);
  for (uint32_t syllable = 0; syllable < syllables; syllable++) {
    append_letter_of(text, CONSONANTS, sizeof CONSONANTS - 1, state);
    append_letter_of(text, VOWELS, sizeof VOWELS - 1, state);
    if (next_random(state) % CLOSED_SYLLABLE_ODDS == 0) {
      append_letter_of(text, CONSONANTS, sizeof CONSONANTS - 1, state);
    }
  }
  const char *suffix = SUFFIXES[next_random(state) % (sizeof SUFFIXES / sizeof SUFFIXES[0])];
  for (size_t letter = 0; suffix[letter] != '\0'; letter++) { append_letter(text, suffix[letter]); }
}

static void build_texts(sample_text *texts) {
  uint32_t state = FIRST_RANDOM_STATE;
  for (uint32_t index = 0; index < TEXTS; index++) {
    texts[index].length = 0;
    for (uint32_t word = 0; word < WORDS_PER_TEXT; word++) {
      if (word > 0) { append_letter(&texts[index], ' '); }
      append_word(&texts[index], &state);
    }
  }
}

static uint64_t mix(uint64_t hash, uint32_t value) { return (hash ^ value) * FNV64_PRIME; }

static uint64_t mix_units(uint64_t hash, const uint16_t *units, uint32_t length) {
  hash = mix(hash, length);
  for (uint32_t unit = 0; unit < length; unit++) { hash = mix(hash, units[unit]); }
  return hash;
}

static uint64_t digest_of(const narsil_tokens *tokens) {
  uint64_t hash = mix(FNV64_OFFSET_BASIS, tokens->token_count);
  for (uint32_t index = 0; index < tokens->token_count; index++) {
    const narsil_token *token = &tokens->tokens[index];
    hash = mix(hash, token->position);
    hash = mix(hash, token->original_offset);
    hash = mix(hash, token->original_length);
    hash = mix_units(hash, tokens->units + token->term_offset, token->term_length);
    hash = token->surface_offset == NARSIL_NO_SURFACE
               ? mix(hash, NARSIL_NO_SURFACE)
               : mix_units(hash, tokens->units + token->surface_offset, token->surface_length);
  }
  return hash;
}

static narsil_status analyse_text(narsil_analyser *analyser, uint32_t language, const sample_text *text,
                                  uint64_t *digest, uint32_t *token_count) {
  narsil_analysis_request request = {language, NULL, ANALYSIS_FLAGS, text->units, text->length};
  narsil_tokens tokens = {NULL, 0, NULL, 0};
  narsil_status status = narsil_analyse(analyser, &request, &tokens);
  if (status == NARSIL_OK) {
    *digest = digest_of(&tokens);
    *token_count = tokens.token_count;
  }
  return status;
}

static void *analyse_beside_other_threads(void *argument) {
  analyser_thread *state = argument;
  narsil_analyser *analyser = NULL;
  state->status = narsil_analyser_create(&analyser);
  if (state->status != NARSIL_OK) { return NULL; }
  for (uint32_t round = 0; round < ROUNDS_PER_THREAD && state->status == NARSIL_OK; round++) {
    for (uint32_t step = 0; step < TEXTS && state->status == NARSIL_OK; step++) {
      uint32_t index = (state->first_text + (round * ROUND_STRIDE) + step) % TEXTS;
      uint64_t digest = 0;
      uint32_t token_count = 0;
      state->status = analyse_text(analyser, state->language, &state->texts[index], &digest, &token_count);
      state->mismatches += digest != state->expected[index];
    }
  }
  narsil_analyser_destroy(analyser);
  return NULL;
}

static int expected_digests(uint32_t language, const sample_text *texts, uint64_t *expected) {
  narsil_analyser *analyser = NULL;
  if (narsil_analyser_create(&analyser) != NARSIL_OK) { return 0; }
  int ready = 1;
  for (uint32_t index = 0; index < TEXTS && ready; index++) {
    uint32_t token_count = 0;
    ready = analyse_text(analyser, language, &texts[index], &expected[index], &token_count) == NARSIL_OK &&
            token_count == WORDS_PER_TEXT;
  }
  narsil_analyser_destroy(analyser);
  return ready;
}

static void run_analyser_threads(uint32_t language, const sample_text *texts, const uint64_t *expected) {
  pthread_t threads[ANALYSER_THREADS];
  analyser_thread states[ANALYSER_THREADS];
  int started[ANALYSER_THREADS];
  for (uint32_t thread = 0; thread < ANALYSER_THREADS; thread++) {
    states[thread] = (analyser_thread){texts, expected, language, thread * (TEXTS / ANALYSER_THREADS), 0, NARSIL_OK};
    started[thread] = pthread_create(&threads[thread], NULL, analyse_beside_other_threads, &states[thread]) == 0;
    check(started[thread], "the test starts an analyser thread");
  }
  for (uint32_t thread = 0; thread < ANALYSER_THREADS; thread++) {
    if (!started[thread]) { continue; }
    check(pthread_join(threads[thread], NULL) == 0, "the test joins an analyser thread");
    check(states[thread].status == NARSIL_OK, "every analysis beside other threads returns NARSIL_OK");
    check(states[thread].mismatches == 0, "every thread analyses each text exactly as one thread alone does");
  }
}

void analysis_thread_checks(void) {
  uint32_t language = 0;
  check(narsil_language_lookup(ENGLISH, strlen(ENGLISH), &language) == NARSIL_OK, "the core holds English");
  sample_text *texts = calloc(TEXTS, sizeof *texts);
  uint64_t *expected = calloc(TEXTS, sizeof *expected);
  check(texts != NULL && expected != NULL, "the analysis texts have their memory");
  if (texts != NULL && expected != NULL) {
    build_texts(texts);
    int ready = expected_digests(language, texts, expected);
    check(ready, "one analyser alone keeps every word of every text");
    if (ready) { run_analyser_threads(language, texts, expected); }
  }
  free(texts);
  free(expected);
}

#else

void analysis_thread_checks(void) {}

#endif
