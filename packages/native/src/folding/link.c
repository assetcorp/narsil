#include "table.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_expansion.h"
#include "../../include/narsil_folding.h"
#include "../allocation.h"
#include "../expansion/internal.h"
#include "../terms/dictionary.h"
#include "folding.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

enum { LAST_ASCII_POINT = 0x7F, FIRST_LINKS = 16 };

typedef struct {
  uint32_t entry;
  uint32_t surface;
} surface_link;

static int is_ascii(term_cursor cursor) {
  uint32_t point = 0;
  int status = 0;
  while ((status = term_next(&cursor, &point)) > 0) {
    if (point > LAST_ASCII_POINT) { return 0; }
  }
  return status == 0;
}

static size_t leading_tokens(const narsil_fold_table *table) {
  size_t count = 0;
  while (count < table->count && table->entries[count].kind == FOLD_TOKEN) { count++; }
  return count;
}

static int64_t token_entry(const narsil_fold_table *table, size_t tokens, uint32_t token) {
  size_t low = 0;
  size_t high = tokens;
  while (low < high) {
    size_t middle = low + ((high - low) / 2);
    uint32_t held = table->entries[middle].token;
    if (held == token) { return (int64_t)middle; }
    if (held < token) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return -1;
}

static narsil_status push_link(surface_link **links, size_t *count, size_t *capacity, surface_link link) {
  if (*count == *capacity) {
    size_t grown = *capacity == 0 ? FIRST_LINKS : *capacity * 2;
    if (grown > SIZE_MAX / sizeof **links) { return NARSIL_OUT_OF_MEMORY; }
    surface_link *moved = core_reallocate(*links, grown * sizeof **links);
    if (moved == NULL) { return NARSIL_OUT_OF_MEMORY; }
    *links = moved;
    *capacity = grown;
  }
  (*links)[(*count)++] = link;
  return NARSIL_OK;
}

static narsil_status collect_links(narsil_workspace *workspace, const narsil_fold_table *table,
                                   const narsil_expansion_segment *segment, int ascii_folds, surface_link **links,
                                   size_t *count) {
  size_t tokens = leading_tokens(table);
  size_t capacity = 0;
  uint32_t surfaces = expansion_surface_count(segment);
  expansion_scratch *scratch = workspace_expansion_scratch(workspace);
  for (uint32_t surface = 0; tokens > 0 && surface < surfaces; surface++) {
    term_cursor spelling;
    term_cursor token_text;
    uint32_t occurrences = 0;
    if (!expansion_surface(segment, surface, &spelling, &token_text, &occurrences) ||
        (!ascii_folds && is_ascii(token_text))) {
      continue;
    }
    uint32_t token = 0;
    uint32_t found = 0;
    narsil_status status = expansion_find(workspace, scratch, segment, token_text, &token, &found);
    if (status != NARSIL_OK) { return status; }
    int64_t entry = found == 0 ? -1 : token_entry(table, tokens, token);
    if (entry < 0) { continue; }
    status = push_link(links, count, &capacity, (surface_link){(uint32_t)entry, surface});
    if (status != NARSIL_OK) { return status; }
  }
  return NARSIL_OK;
}

static narsil_status place_links(narsil_fold_table *table, const surface_link *links, size_t count) {
  if (count > table->token_surface_capacity) {
    if (count > SIZE_MAX / sizeof *table->token_surfaces) { return NARSIL_OUT_OF_MEMORY; }
    uint32_t *grown = core_reallocate(table->token_surfaces, count * sizeof *grown);
    if (grown == NULL) { return NARSIL_OUT_OF_MEMORY; }
    table->token_surfaces = grown;
    table->token_surface_capacity = count;
  }
  for (size_t at = 0; at < table->count; at++) {
    table->entries[at].surfaces_start = 0;
    table->entries[at].surfaces_count = 0;
  }
  for (size_t at = 0; at < count; at++) { table->entries[links[at].entry].surfaces_count++; }
  uint32_t start = 0;
  for (size_t at = 0; at < table->count; at++) {
    table->entries[at].surfaces_start = start;
    start += table->entries[at].surfaces_count;
    table->entries[at].surfaces_count = 0;
  }
  for (size_t at = 0; at < count; at++) {
    fold_entry *entry = table->entries + links[at].entry;
    table->token_surfaces[entry->surfaces_start + entry->surfaces_count++] = links[at].surface;
  }
  table->token_surface_count = count;
  return NARSIL_OK;
}

narsil_status fold_link_token_surfaces(narsil_workspace *workspace, narsil_fold_table *table,
                                       const narsil_expansion_segment *segment, uint32_t language) {
  surface_link *links = NULL;
  size_t count = 0;
  int ascii_folds = narsil_language_folding_table[language].ascii_letters != 0;
  narsil_status status = collect_links(workspace, table, segment, ascii_folds, &links, &count);
  if (status == NARSIL_OK) { status = place_links(table, links, count); }
  free(links);
  return status;
}
