#ifndef NARSIL_FOLDING_TABLE_H
#define NARSIL_FOLDING_TABLE_H

#include "../../include/narsil_core.h"
#include "../../include/narsil_expansion.h"
#include "../../include/narsil_folding.h"
#include "../analysis/text.h"
#include "../terms/dictionary.h"

#include <stddef.h>
#include <stdint.h>

enum { FOLD_TOKEN, FOLD_SURFACE, FOLD_SPELLING, FOLD_KINDS };

typedef struct {
  uint32_t kind;
  uint32_t entry;
  uint32_t token;
  uint32_t fold_start;
  uint32_t fold_length;
  uint32_t fold_points;
  uint32_t key_start;
  uint32_t key_length;
  uint32_t surfaces_start;
  uint32_t surfaces_count;
} fold_entry;

struct narsil_fold_table {
  int built;
  uint32_t language;
  const void *identity;
  uint32_t scanned[FOLD_KINDS];
  uint32_t generations[FOLD_KINDS];
  fold_entry *entries;
  size_t count;
  size_t capacity;
  uint32_t *by_key;
  uint32_t *by_fold;
  uint32_t *order_scratch;
  narsil_text units;
  uint32_t *token_surfaces;
  size_t token_surface_count;
  size_t token_surface_capacity;
};

typedef struct {
  const uint16_t *units;
  size_t length;
} fold_text;

int fold_table_matches(const narsil_fold_table *table, const narsil_expansion_segment *segment);
fold_text fold_entry_fold(const narsil_fold_table *table, const fold_entry *entry);
fold_text fold_entry_key(const narsil_fold_table *table, const fold_entry *entry);
int fold_compare_points(fold_text left, fold_text right);
int fold_starts_with(fold_text text, fold_text prefix);
int fold_entry_held(const narsil_fold_table *table, const fold_entry *entry, const narsil_expansion_segment *segment);
size_t fold_lower_key(const narsil_fold_table *table, fold_text key);
size_t fold_lower_fold(const narsil_fold_table *table, fold_text fold);
narsil_status fold_table_sort(narsil_fold_table *table);
narsil_status fold_link_token_surfaces(narsil_workspace *workspace, narsil_fold_table *table,
                                       const narsil_expansion_segment *segment, uint32_t language);

#endif
