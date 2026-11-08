#ifndef NARSIL_SEGMENT_STRINGS_H
#define NARSIL_SEGMENT_STRINGS_H

#include "../../include/narsil_terms.h"

#include <stddef.h>
#include <stdint.h>

typedef struct {
  const uint16_t *text;
  size_t length;
  uint32_t ordinal;
  uint32_t slot;
  uint32_t added;
  uint32_t token;
  uint32_t count;
  uint32_t points;
  uint32_t hash;
} segment_string;

typedef struct {
  segment_string *entries;
  uint32_t *slots;
  uint32_t *placements;
  size_t capacity;
  size_t slot_capacity;
  size_t count;
  size_t added;
  size_t units;
} segment_strings;

narsil_status segment_strings_reserve(segment_strings *strings, size_t capacity);
void segment_strings_reset(segment_strings *strings);
void segment_strings_release(segment_strings *strings);
size_t segment_strings_bytes(const segment_strings *strings);
segment_string *segment_string_find(segment_strings *strings, const uint16_t *text, size_t length);
narsil_status segment_string_prepare(segment_strings *strings, const narsil_term_table *table, const uint16_t *text,
                                     size_t length, segment_string **entry);
narsil_status segment_string_prepare_existing(segment_strings *strings, const narsil_term_table *table,
                                              const uint16_t *text, size_t length, segment_string **entry);
narsil_status segment_strings_check(segment_strings *strings, const narsil_term_table *table);
void segment_strings_publish(const segment_strings *strings, narsil_term_table *table);
void segment_string_remove(narsil_term_table *table, const segment_string *entry);
narsil_status segment_string_add_count(segment_string *entry, uint32_t current, uint32_t added);

#endif
