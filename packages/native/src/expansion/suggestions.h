#ifndef NARSIL_EXPANSION_SUGGESTIONS_H
#define NARSIL_EXPANSION_SUGGESTIONS_H

#include "../../include/narsil_suggestions.h"
#include "../terms/dictionary.h"

#include <stddef.h>
#include <stdint.h>

typedef struct {
  term_cursor text;
  term_cursor spelling;
  uint32_t segment;
  uint32_t token;
  uint32_t kind;
  uint32_t entry;
  double occurrences;
  uint32_t documents;
} suggestion_entry;

typedef struct {
  term_cursor text;
  uint32_t segment;
  uint32_t token;
  uint32_t documents;
  size_t start;
  size_t end;
} suggestion_group;

typedef struct {
  suggestion_entry *entries;
  size_t count;
  size_t capacity;
  suggestion_group *groups;
  size_t group_count;
  size_t group_capacity;
} suggestion_scratch;

void suggestion_release(suggestion_scratch *scratch);
size_t suggestion_bytes(const suggestion_scratch *scratch);
narsil_status suggestion_append(suggestion_scratch *scratch, suggestion_entry entry);
narsil_status suggestion_rank(suggestion_scratch *scratch);

#endif
