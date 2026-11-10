#include "../../include/narsil_core.h"
#include "internal.h"
#include "suggestions.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

enum { FIRST_SUGGESTIONS = 32 };

void suggestion_release(suggestion_scratch *scratch) {
  free(scratch->entries);
  free(scratch->groups);
  *scratch = (suggestion_scratch){0};
}

size_t suggestion_bytes(const suggestion_scratch *scratch) {
  return (scratch->capacity * sizeof *scratch->entries) + (scratch->group_capacity * sizeof *scratch->groups);
}

narsil_status suggestion_append(suggestion_scratch *scratch, suggestion_entry entry) {
  if (scratch->count == scratch->capacity) {
    if (scratch->capacity > SIZE_MAX / 2) { return NARSIL_OUT_OF_MEMORY; }
    size_t capacity = scratch->capacity == 0 ? FIRST_SUGGESTIONS : scratch->capacity * 2;
    if (capacity > SIZE_MAX / sizeof *scratch->entries) { return NARSIL_OUT_OF_MEMORY; }
    void *grown = realloc(scratch->entries, capacity * sizeof *scratch->entries);
    if (grown == NULL) { return NARSIL_OUT_OF_MEMORY; }
    scratch->entries = grown;
    scratch->capacity = capacity;
  }
  scratch->entries[scratch->count++] = entry;
  return NARSIL_OK;
}

static int source_order(const suggestion_entry *first, const suggestion_entry *second) {
  int order = expansion_compare(first->text, second->text);
  if (order != 0) { return order; }
  if (first->segment != second->segment) { return first->segment < second->segment ? -1 : 1; }
  order = expansion_compare(first->spelling, second->spelling);
  if (order != 0) { return order; }
  return (first->kind < second->kind) - (first->kind > second->kind);
}

static int by_source(const void *first, const void *second) { return source_order(first, second); }

static int spelling_order(const suggestion_entry *first, const suggestion_entry *second) {
  int order = expansion_compare(first->spelling, second->spelling);
  if (order != 0) { return order; }
  return (first->segment > second->segment) - (first->segment < second->segment);
}

static int by_spelling(const void *first, const void *second) { return spelling_order(first, second); }

static int by_occurrences(const void *left, const void *right) {
  const suggestion_entry *first = left;
  const suggestion_entry *second = right;
  if (first->occurrences != second->occurrences) { return first->occurrences > second->occurrences ? -1 : 1; }
  return by_spelling(left, right);
}

static int frequency_order(const suggestion_group *first, const suggestion_group *second) {
  if (first->documents != second->documents) { return first->documents > second->documents ? -1 : 1; }
  return expansion_compare(first->text, second->text);
}

static int by_frequency(const void *first, const void *second) { return frequency_order(first, second); }

static size_t unite_spellings(suggestion_entry *entries, size_t count) {
  qsort(entries, count, sizeof *entries, by_spelling);
  size_t kept = 0;
  for (size_t at = 0; at < count;) {
    suggestion_entry entry = entries[at++];
    while (at < count && expansion_compare(entry.spelling, entries[at].spelling) == 0) {
      entry.occurrences += entries[at++].occurrences;
    }
    entries[kept++] = entry;
  }
  qsort(entries, kept, sizeof *entries, by_occurrences);
  return kept;
}

static narsil_status group_tokens(suggestion_scratch *scratch) {
  size_t kept = 0;
  for (size_t at = 0; at < scratch->count;) {
    suggestion_entry first = scratch->entries[at];
    suggestion_group group = {first.text, first.segment, first.token, 0, kept, 0};
    uint32_t previous = first.segment;
    int counted = 0;
    do {
      suggestion_entry entry = scratch->entries[at++];
      if (!counted || previous != entry.segment) {
        if (entry.documents > UINT32_MAX - group.documents) { return NARSIL_INVALID_ARGUMENT; }
        group.documents += entry.documents;
        previous = entry.segment;
        counted = 1;
      }
      while (at < scratch->count && scratch->entries[at].segment == entry.segment &&
             expansion_compare(entry.text, scratch->entries[at].text) == 0 &&
             expansion_compare(entry.spelling, scratch->entries[at].spelling) == 0) {
        at++;
      }
      scratch->entries[kept++] = entry;
    } while (at < scratch->count && expansion_compare(first.text, scratch->entries[at].text) == 0);
    kept = group.start + unite_spellings(scratch->entries + group.start, kept - group.start);
    group.end = kept;
    scratch->groups[scratch->group_count++] = group;
  }
  scratch->count = kept;
  return NARSIL_OK;
}

narsil_status suggestion_rank(suggestion_scratch *scratch) {
  scratch->group_count = 0;
  if (scratch->count == 0) { return NARSIL_OK; }
  if (scratch->count > scratch->group_capacity) {
    if (scratch->count > SIZE_MAX / sizeof *scratch->groups) { return NARSIL_OUT_OF_MEMORY; }
    void *grown = realloc(scratch->groups, scratch->count * sizeof *scratch->groups);
    if (grown == NULL) { return NARSIL_OUT_OF_MEMORY; }
    scratch->groups = grown;
    scratch->group_capacity = scratch->count;
  }
  qsort(scratch->entries, scratch->count, sizeof *scratch->entries, by_source);
  narsil_status status = group_tokens(scratch);
  if (status == NARSIL_OK) { qsort(scratch->groups, scratch->group_count, sizeof *scratch->groups, by_frequency); }
  return status;
}
