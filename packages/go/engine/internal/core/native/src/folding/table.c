#include "table.h"

#include "../../include/narsil_analysis.h"
#include "../../include/narsil_core.h"
#include "../../include/narsil_expansion.h"
#include "../../include/narsil_folding.h"
#include "../../include/narsil_terms.h"
#include "../allocation.h"
#include "../analysis/analyser.h"
#include "../analysis/text.h"
#include "../expansion/internal.h"
#include "../segments/regions.h"
#include "../terms/dictionary.h"
#include "../terms/table.h"
#include "folding.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

enum { FIRST_FOLD_ENTRIES = 64 };

typedef struct {
  uint32_t counts[FOLD_KINDS];
  uint32_t generations[FOLD_KINDS];
} fold_marks_of_segment;

typedef struct {
  narsil_workspace *workspace;
  narsil_analyser *analyser;
  narsil_fold_table *table;
  const narsil_expansion_segment *segment;
  uint32_t language;
  narsil_text spelling;
} fold_build;

typedef struct {
  uint32_t first;
  uint32_t end;
} fold_range;

static const void *identity_of(const narsil_expansion_segment *segment) {
  if (segment->growing != NULL) { return segment->growing->terms.header; }
  return segment->frozen->terms.offsets;
}

static uint32_t table_count(const narsil_term_table *strings) { return strings->header[TERM_COUNT]; }

static uint32_t table_generation(const narsil_term_table *strings) { return strings->header[TERM_GENERATION]; }

static fold_marks_of_segment marks_of(const narsil_expansion_segment *segment) {
  fold_marks_of_segment marks = {{0}, {0}};
  if (segment->growing != NULL) {
    const narsil_growing_segment *growing = segment->growing;
    marks.counts[FOLD_TOKEN] = table_count(&growing->terms);
    marks.generations[FOLD_TOKEN] = table_generation(&growing->terms);
    if (growing->surfaces != NULL) {
      marks.counts[FOLD_SURFACE] = table_count(&growing->surfaces->strings);
      marks.generations[FOLD_SURFACE] = table_generation(&growing->surfaces->strings);
    }
    if (growing->spellings != NULL) {
      marks.counts[FOLD_SPELLING] = table_count(&growing->spellings->entries.strings);
      marks.generations[FOLD_SPELLING] = table_generation(&growing->spellings->entries.strings);
    }
    return marks;
  }
  const narsil_frozen_segment *frozen = segment->frozen;
  marks.counts[FOLD_TOKEN] = (uint32_t)frozen->terms.count;
  marks.counts[FOLD_SURFACE] = frozen->surfaces == NULL ? 0 : (uint32_t)frozen->surfaces->count;
  marks.counts[FOLD_SPELLING] = frozen->spellings == NULL ? 0 : (uint32_t)frozen->spellings->count;
  return marks;
}

int fold_table_matches(const narsil_fold_table *table, const narsil_expansion_segment *segment) {
  if (table == NULL || segment == NULL || !table->built || table->identity != identity_of(segment)) { return 0; }
  fold_marks_of_segment marks = marks_of(segment);
  for (size_t kind = 0; kind < FOLD_KINDS; kind++) {
    if (marks.counts[kind] != table->scanned[kind] || marks.generations[kind] != table->generations[kind]) { return 0; }
  }
  return 1;
}

narsil_status narsil_fold_table_create(narsil_fold_table **table) {
  if (table == NULL) { return NARSIL_INVALID_ARGUMENT; }
  narsil_fold_table *created = core_allocate_zeroed(1, sizeof *created);
  if (created == NULL) { return NARSIL_OUT_OF_MEMORY; }
  *table = created;
  return NARSIL_OK;
}

static void release_entries(narsil_fold_table *table) {
  free(table->entries);
  free(table->by_key);
  free(table->by_fold);
  free(table->order_scratch);
  free(table->token_surfaces);
  narsil_text_release(&table->units);
  table->entries = NULL;
  table->by_key = NULL;
  table->by_fold = NULL;
  table->order_scratch = NULL;
  table->token_surfaces = NULL;
  table->count = 0;
  table->capacity = 0;
  table->token_surface_count = 0;
  table->token_surface_capacity = 0;
}

void narsil_fold_table_destroy(narsil_fold_table *table) {
  if (table == NULL) { return; }
  release_entries(table);
  free(table);
}

size_t narsil_fold_table_bytes(const narsil_fold_table *table) {
  if (table == NULL) { return 0; }
  return sizeof *table + (table->capacity * (sizeof *table->entries + (3 * sizeof *table->by_key))) +
         (table->units.capacity * sizeof *table->units.units) +
         (table->token_surface_capacity * sizeof *table->token_surfaces);
}

int narsil_fold_table_current(const narsil_fold_table *table, const narsil_expansion_segment *segment,
                              uint32_t language) {
  return table != NULL && table->language == language && fold_table_matches(table, segment);
}

static void reset(narsil_fold_table *table) {
  table->built = 0;
  table->count = 0;
  table->units.length = 0;
  table->token_surface_count = 0;
  for (size_t kind = 0; kind < FOLD_KINDS; kind++) {
    table->scanned[kind] = 0;
    table->generations[kind] = 0;
  }
}

static narsil_status reserve_entries(narsil_fold_table *table) {
  if (table->count < table->capacity) { return NARSIL_OK; }
  if (table->capacity > UINT32_MAX / 2) { return NARSIL_OUT_OF_MEMORY; }
  size_t capacity = table->capacity == 0 ? FIRST_FOLD_ENTRIES : table->capacity * 2;
  fold_entry *entries = core_reallocate(table->entries, capacity * sizeof *entries);
  if (entries == NULL) { return NARSIL_OUT_OF_MEMORY; }
  table->entries = entries;
  uint32_t *by_key = core_reallocate(table->by_key, capacity * sizeof *by_key);
  if (by_key == NULL) { return NARSIL_OUT_OF_MEMORY; }
  table->by_key = by_key;
  uint32_t *by_fold = core_reallocate(table->by_fold, capacity * sizeof *by_fold);
  if (by_fold == NULL) { return NARSIL_OUT_OF_MEMORY; }
  table->by_fold = by_fold;
  uint32_t *order = core_reallocate(table->order_scratch, capacity * sizeof *order);
  if (order == NULL) { return NARSIL_OUT_OF_MEMORY; }
  table->order_scratch = order;
  table->capacity = capacity;
  return NARSIL_OK;
}

static narsil_status append_units(narsil_fold_table *table, narsil_unit_view view, uint32_t *start) {
  if (table->units.length > UINT32_MAX - view.length) { return NARSIL_OUT_OF_MEMORY; }
  *start = (uint32_t)table->units.length;
  return (narsil_status)narsil_text_append(&table->units, view.units, view.length);
}

static narsil_status add_spelling(fold_build *build, uint32_t kind, uint32_t entry, uint32_t token) {
  narsil_unit_view spelling = {build->spelling.units, build->spelling.length};
  narsil_unit_view fold = {NULL, 0};
  int status = narsil_fold_view(build->analyser, build->language, spelling, 0, &fold);
  if (status != NARSIL_OK) { return (narsil_status)status; }
  if (narsil_units_equal(fold.units, fold.length, spelling.units, spelling.length)) { return NARSIL_OK; }
  narsil_fold_table *table = build->table;
  narsil_status reserved = reserve_entries(table);
  if (reserved != NARSIL_OK) { return reserved; }
  fold_entry added = {kind, entry, token, 0, 0, 0, 0, 0, 0, 0};
  size_t points = 0;
  if (!expansion_point_count((term_cursor){fold.units, NULL, 0, fold.length}, &points)) { return NARSIL_OK; }
  added.fold_points = (uint32_t)points;
  reserved = append_units(table, fold, &added.fold_start);
  if (reserved != NARSIL_OK) { return reserved; }
  added.fold_length = (uint32_t)fold.length;
  narsil_unit_view key = {NULL, 0};
  status = narsil_fold_view(build->analyser, build->language, spelling, NARSIL_FOLD_STEM, &key);
  if (status != NARSIL_OK) { return (narsil_status)status; }
  reserved = append_units(table, key, &added.key_start);
  if (reserved != NARSIL_OK) { return reserved; }
  added.key_length = (uint32_t)key.length;
  table->entries[table->count++] = added;
  return NARSIL_OK;
}

static narsil_status scan_tokens(fold_build *build, fold_range range) {
  narsil_term_dictionary dictionary;
  if (!expansion_dictionary(build->segment, &dictionary)) { return NARSIL_INVALID_ARGUMENT; }
  for (uint32_t ordinal = range.first; ordinal < range.end; ordinal++) {
    term_cursor cursor;
    if (!dictionary_cursor(&dictionary, ordinal, &cursor)) { continue; }
    int status = expansion_cursor_text(cursor, &build->spelling);
    if (status == NARSIL_INVALID_ARGUMENT) { continue; }
    if (status != NARSIL_OK) { return (narsil_status)status; }
    narsil_status added = add_spelling(build, FOLD_TOKEN, ordinal, ordinal);
    if (added != NARSIL_OK) { return added; }
  }
  return NARSIL_OK;
}

static int growing_string(const narsil_term_table *strings, uint32_t entry, term_cursor *cursor) {
  size_t start = strings->term_offset[entry];
  size_t length = strings->term_length[entry];
  size_t used = strings->header[TERM_UNITS_USED];
  if (start > used || length > used - start) { return 0; }
  *cursor = (term_cursor){strings->units, NULL, start, start + length};
  return 1;
}

static narsil_status frozen_surface(fold_build *build, uint32_t entry, term_cursor *spelling, uint32_t *token,
                                    uint32_t *found) {
  term_cursor token_text;
  uint32_t occurrences = 0;
  *found = 0;
  if (!expansion_surface(build->segment, entry, spelling, &token_text, &occurrences)) { return NARSIL_OK; }
  expansion_scratch *scratch = workspace_expansion_scratch(build->workspace);
  return expansion_find(build->workspace, scratch, build->segment, token_text, token, found);
}

static narsil_status add_cursor(fold_build *build, term_cursor spelling, uint32_t kind, uint32_t entry,
                                uint32_t token) {
  int converted = expansion_cursor_text(spelling, &build->spelling);
  if (converted == NARSIL_INVALID_ARGUMENT) { return NARSIL_OK; }
  if (converted != NARSIL_OK) { return (narsil_status)converted; }
  return add_spelling(build, kind, entry, token);
}

static narsil_status scan_surfaces(fold_build *build, fold_range range) {
  const narsil_growing_segment *growing = build->segment->growing;
  for (uint32_t entry = range.first; entry < range.end; entry++) {
    term_cursor spelling;
    uint32_t token = 0;
    uint32_t found = 1;
    if (growing != NULL) {
      if (!growing_string(&growing->surfaces->strings, entry, &spelling)) { continue; }
      token = growing->surfaces->token[entry];
    } else {
      narsil_status status = frozen_surface(build, entry, &spelling, &token, &found);
      if (status != NARSIL_OK) { return status; }
    }
    if (found == 0) { continue; }
    narsil_status status = add_cursor(build, spelling, FOLD_SURFACE, entry, token);
    if (status != NARSIL_OK) { return status; }
  }
  return NARSIL_OK;
}

static narsil_status scan_spellings(fold_build *build, fold_range range) {
  const narsil_growing_segment *growing = build->segment->growing;
  for (uint32_t entry = range.first; entry < range.end; entry++) {
    term_cursor spelling;
    uint32_t token = 0;
    if (growing != NULL) {
      if (!growing_string(&growing->spellings->entries.strings, entry, &spelling)) { continue; }
      token = growing->spellings->entries.token[entry];
    } else {
      size_t length = 0;
      if (!partial_spelling(build->segment, entry, &spelling, &token, &length)) { continue; }
    }
    narsil_status status = add_cursor(build, spelling, FOLD_SPELLING, entry, token);
    if (status != NARSIL_OK) { return status; }
  }
  return NARSIL_OK;
}

static narsil_status scan(fold_build *build, fold_marks_of_segment marks) {
  narsil_fold_table *table = build->table;
  narsil_status status = scan_tokens(build, (fold_range){table->scanned[FOLD_TOKEN], marks.counts[FOLD_TOKEN]});
  if (status == NARSIL_OK) {
    status = scan_surfaces(build, (fold_range){table->scanned[FOLD_SURFACE], marks.counts[FOLD_SURFACE]});
  }
  if (status == NARSIL_OK) {
    status = scan_spellings(build, (fold_range){table->scanned[FOLD_SPELLING], marks.counts[FOLD_SPELLING]});
  }
  if (status == NARSIL_OK) { status = fold_table_sort(table); }
  if (status == NARSIL_OK && build->segment->growing == NULL) {
    status = fold_link_token_surfaces(build->workspace, table, build->segment, build->language);
  }
  return status;
}

static int extends(const narsil_fold_table *table, const narsil_expansion_segment *segment, uint32_t language,
                   fold_marks_of_segment marks) {
  if (!table->built || table->language != language || table->identity != identity_of(segment) ||
      segment->growing == NULL) {
    return 0;
  }
  for (size_t kind = 0; kind < FOLD_KINDS; kind++) {
    if (marks.generations[kind] != table->generations[kind] || marks.counts[kind] < table->scanned[kind]) { return 0; }
  }
  return 1;
}

narsil_status narsil_fold_table_update(narsil_workspace *workspace, narsil_analyser *analyser, narsil_fold_table *table,
                                       const narsil_expansion_segment *segment, uint32_t language) {
  if (workspace == NULL || analyser == NULL || table == NULL || segment == NULL ||
      (uintptr_t)segment % _Alignof(narsil_expansion_segment) != 0 ||
      narsil_language_folding_table_length != narsil_language_count() || language >= narsil_language_count()) {
    return NARSIL_INVALID_ARGUMENT;
  }
  segment_regions regions = {0};
  if (!expansion_source_regions(segment, &regions)) { return NARSIL_INVALID_ARGUMENT; }
  if (narsil_fold_table_current(table, segment, language)) { return NARSIL_OK; }
  fold_marks_of_segment marks = marks_of(segment);
  if (!extends(table, segment, language, marks)) { reset(table); }
  table->built = 0;
  fold_build build = {workspace, analyser, table, segment, language, {NULL, 0, 0}};
  narsil_status status = scan(&build, marks);
  narsil_text_release(&build.spelling);
  if (status != NARSIL_OK) {
    reset(table);
    return status;
  }
  for (size_t kind = 0; kind < FOLD_KINDS; kind++) {
    table->scanned[kind] = marks.counts[kind];
    table->generations[kind] = marks.generations[kind];
  }
  table->language = language;
  table->identity = identity_of(segment);
  table->built = 1;
  return NARSIL_OK;
}
