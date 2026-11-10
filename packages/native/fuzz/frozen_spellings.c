#include "frozen_spellings.h"

#include "frozen_segment.h"
#include "input.h"

#include <stddef.h>
#include <stdint.h>

enum { SPELLINGS_PER_TERM = 2, MIN_SPELLING_UNITS = 4 };

static int order_spellings(const fuzz_frozen_word *left, uint32_t left_term, const fuzz_frozen_word *right,
                           uint32_t right_term) {
  uint32_t shorter = left->length < right->length ? left->length : right->length;
  for (uint32_t at = 0; at < shorter; at++) {
    if (left->units[at] != right->units[at]) { return left->units[at] < right->units[at] ? -1 : 1; }
  }
  if (left->length != right->length) { return left->length < right->length ? -1 : 1; }
  return (left_term > right_term) - (left_term < right_term);
}

static void add_spelling(fuzz_frozen *frozen, const fuzz_frozen_word *word, uint32_t term) {
  size_t place = frozen->spelling_count;
  while (place > 0 &&
         order_spellings(&frozen->spelling_words[place - 1], frozen->spelling_terms[place - 1], word, term) > 0) {
    place--;
  }
  if (place > 0 &&
      order_spellings(&frozen->spelling_words[place - 1], frozen->spelling_terms[place - 1], word, term) == 0) {
    return;
  }
  for (size_t at = frozen->spelling_count; at > place; at--) {
    frozen->spelling_words[at] = frozen->spelling_words[at - 1];
    frozen->spelling_terms[at] = frozen->spelling_terms[at - 1];
  }
  frozen->spelling_words[place] = *word;
  frozen->spelling_terms[place] = term;
  frozen->spelling_count++;
}

void fuzz_frozen_choose_spellings(fuzz_input *input, fuzz_frozen *frozen, size_t terms) {
  for (uint32_t term = 0; term < terms; term++) {
    uint32_t chosen = fuzz_below(input, SPELLINGS_PER_TERM + 1);
    for (uint32_t spelling = 0; spelling < chosen; spelling++) {
      fuzz_frozen_word word = frozen->terms[term];
      uint32_t length = MIN_SPELLING_UNITS + fuzz_below(input, FUZZ_FROZEN_MAX_WORD_UNITS - MIN_SPELLING_UNITS + 1);
      while (word.length < length) {
        word.units[word.length++] = (uint16_t)(FUZZ_FROZEN_FIRST_LETTER + fuzz_below(input, FUZZ_FROZEN_LETTERS));
      }
      add_spelling(frozen, &word, term);
    }
  }
}

static int order_runs(const fuzz_frozen_run *left, const fuzz_frozen_run *right) {
  for (size_t at = 0; at < FUZZ_FROZEN_RUN_POINTS; at++) {
    if (left->points[at] != right->points[at]) { return left->points[at] < right->points[at] ? -1 : 1; }
  }
  return (left->entry > right->entry) - (left->entry < right->entry);
}

size_t fuzz_frozen_collect_runs(const fuzz_frozen *frozen, fuzz_frozen_run *pairs) {
  size_t count = 0;
  for (uint32_t entry = 0; entry < frozen->spelling_count; entry++) {
    const fuzz_frozen_word *word = &frozen->spelling_words[entry];
    for (uint32_t start = 0; start + FUZZ_FROZEN_RUN_POINTS <= word->length; start++) {
      fuzz_frozen_run pair = {{word->units[start], word->units[start + 1], word->units[start + 2]}, entry};
      size_t place = count;
      while (place > 0 && order_runs(&pairs[place - 1], &pair) > 0) { place--; }
      if (place > 0 && order_runs(&pairs[place - 1], &pair) == 0) { continue; }
      for (size_t at = count; at > place; at--) { pairs[at] = pairs[at - 1]; }
      pairs[place] = pair;
      count++;
    }
  }
  return count;
}
