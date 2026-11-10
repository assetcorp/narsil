#include "dictionary.h"

#include "../../include/narsil_terms.h"
#include "../regions.h"
#include "table.h"

#include <stddef.h>
#include <stdint.h>

uint32_t dictionary_count(const narsil_term_dictionary *dictionary) {
  return dictionary->growing == NULL ? (uint32_t)dictionary->frequency_count : dictionary->growing->header[TERM_COUNT];
}

int dictionary_regions(const narsil_term_dictionary *dictionary, memory_region regions[DICTIONARY_REGIONS]) {
  if (dictionary == NULL || dictionary->frequency_count > UINT32_MAX ||
      dictionary->removed_count != dictionary->frequency_count || dictionary->token_bytes > UINT32_MAX ||
      dictionary->offset_count > UINT32_MAX) {
    return 0;
  }
  for (size_t at = 0; at < DICTIONARY_REGIONS; at++) { regions[at] = (memory_region){0, 0}; }
  if (dictionary->growing != NULL) {
    if (!term_table_regions(dictionary->growing, regions) || dictionary->token_bytes != 0 ||
        dictionary->offset_count != 0 || dictionary->frequency_count < dictionary_count(dictionary)) {
      return 0;
    }
  } else if (dictionary->frequency_count == SIZE_MAX || dictionary->offset_count != dictionary->frequency_count + 1) {
    return 0;
  }
  enum { METADATA = TERM_TABLE_REGIONS, TOKENS, OFFSETS, FREQUENCIES, REMOVED };
  return region_of(dictionary, 1, sizeof *dictionary, &regions[METADATA]) &&
         region_of(dictionary->tokens, dictionary->token_bytes, sizeof *dictionary->tokens, &regions[TOKENS]) &&
         region_of(dictionary->offsets, dictionary->offset_count, sizeof *dictionary->offsets, &regions[OFFSETS]) &&
         region_of(dictionary->frequencies, dictionary->frequency_count, sizeof *dictionary->frequencies,
                   &regions[FREQUENCIES]) &&
         region_of(dictionary->removed, dictionary->removed_count, sizeof *dictionary->removed, &regions[REMOVED]);
}

uint32_t dictionary_frequency(const narsil_term_dictionary *dictionary, uint32_t ordinal) {
  if (ordinal >= dictionary_count(dictionary)) { return 0; }
  uint32_t stored = dictionary->frequencies[ordinal];
  uint32_t removed = dictionary->removed[ordinal];
  return removed > stored ? 0 : stored - removed;
}

int dictionary_cursor(const narsil_term_dictionary *dictionary, uint32_t ordinal, term_cursor *cursor) {
  if (ordinal >= dictionary_count(dictionary)) { return 0; }
  const narsil_term_table *table = dictionary->growing;
  if (table != NULL) {
    uint32_t start = table->term_offset[ordinal];
    uint32_t length = table->term_length[ordinal];
    uint32_t used = table->header[TERM_UNITS_USED];
    if (start > used || length > used - start) { return 0; }
    *cursor = (term_cursor){table->units, NULL, start, (size_t)start + length};
  } else {
    uint32_t start = dictionary->offsets[ordinal];
    uint32_t end = dictionary->offsets[(size_t)ordinal + 1];
    if (start > end || end > dictionary->token_bytes) { return 0; }
    *cursor = (term_cursor){NULL, dictionary->tokens, start, end};
  }
  return 1;
}

int dictionary_compare(const narsil_term_dictionary *dictionary, uint32_t left, uint32_t right) {
  term_cursor first;
  term_cursor second;
  if (!dictionary_cursor(dictionary, left, &first) || !dictionary_cursor(dictionary, right, &second)) { return 0; }
  for (;;) {
    uint32_t first_point = 0;
    uint32_t second_point = 0;
    int has_a = term_next(&first, &first_point);
    int has_b = term_next(&second, &second_point);
    if (has_a <= 0 || has_b <= 0) { return has_a - has_b; }
    if (first_point != second_point) { return first_point < second_point ? -1 : 1; }
  }
}
