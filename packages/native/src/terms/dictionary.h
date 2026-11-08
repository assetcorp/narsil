#ifndef NARSIL_TERM_DICTIONARY_INTERNAL_H
#define NARSIL_TERM_DICTIONARY_INTERNAL_H

#include "../../include/narsil_terms.h"
#include "../regions.h"
#include "table.h"

#include <stddef.h>
#include <stdint.h>

enum { DICTIONARY_REGIONS = TERM_TABLE_REGIONS + 5 };

typedef struct {
  const uint16_t *units;
  const uint8_t *bytes;
  size_t at;
  size_t end;
} term_cursor;

int dictionary_regions(const narsil_term_dictionary *dictionary, memory_region regions[DICTIONARY_REGIONS]);
uint32_t dictionary_count(const narsil_term_dictionary *dictionary);
uint32_t dictionary_frequency(const narsil_term_dictionary *dictionary, uint32_t ordinal);
int dictionary_cursor(const narsil_term_dictionary *dictionary, uint32_t ordinal, term_cursor *cursor);
int term_next(term_cursor *cursor, uint32_t *point);
int dictionary_compare(const narsil_term_dictionary *dictionary, uint32_t left, uint32_t right);

#endif
