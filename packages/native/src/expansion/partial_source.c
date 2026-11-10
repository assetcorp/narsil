#include "internal.h"

#include "../../include/narsil_expansion.h"
#include "../../include/narsil_frozen_segments.h"
#include "../../include/narsil_segments.h"
#include "../../include/narsil_terms.h"
#include "../analysis/text.h"
#include "../segments/runs.h"
#include "../terms/dictionary.h"
#include "../terms/table.h"

#include <stddef.h>
#include <stdint.h>

static int64_t growing_run(const narsil_run_table *table, const uint32_t *points) {
  size_t mask = table->slot_capacity - 1;
  size_t slot = segment_run_hash(points) & mask;
  for (size_t scanned = 0; scanned < table->slot_capacity; scanned++) {
    int32_t entry = table->slots[slot];
    if (entry == 0) { return -1; }
    if (entry > 0 && (uint32_t)entry <= table->header[TERM_COUNT] &&
        segment_run_equal(points, table->runs + ((size_t)(entry - 1) * PARTIAL_RUN_POINTS))) {
      return entry - 1;
    }
    slot = (slot + 1) & mask;
  }
  return -1;
}

static int64_t frozen_run(const narsil_frozen_runs *table, const uint32_t *points) {
  size_t low = 0;
  size_t high = table->point_count / PARTIAL_RUN_POINTS;
  while (low < high) {
    size_t middle = low + ((high - low) / 2);
    const uint32_t *held = table->points + (middle * PARTIAL_RUN_POINTS);
    int order = 0;
    for (size_t at = 0; at < PARTIAL_RUN_POINTS && order == 0; at++) {
      order = (held[at] > points[at]) - (held[at] < points[at]);
    }
    if (order == 0) { return (int64_t)middle; }
    if (order < 0) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return -1;
}

static int growing_members(const narsil_run_table *table, const uint32_t *points, const uint32_t **members,
                           size_t *length) {
  int64_t run = growing_run(table, points);
  if (run < 0) { return 0; }
  size_t start = table->list_start[run];
  size_t kind = table->list_class[run];
  size_t allocated = table->allocator.allocation[0];
  *length = table->list_length[run];
  if (kind >= table->allocator.class_count || allocated > table->member_capacity || start > allocated) { return 0; }
  size_t capacity = table->allocator.slice_capacities[kind];
  if (*length > capacity || capacity > allocated - start || *length == 0) { return 0; }
  *members = table->members + start;
  return 1;
}

int partial_members(const narsil_expansion_segment *source, const narsil_frozen_runs *runs,
                    const narsil_code_points *query, const uint32_t **members, size_t *count) {
  const narsil_spelling_table *spellings = source->growing == NULL ? NULL : source->growing->spellings;
  if ((spellings == NULL && runs->offset_count == 0) || query->length < PARTIAL_RUN_POINTS) { return 0; }
  *count = SIZE_MAX;
  for (size_t at = 0; at <= query->length - PARTIAL_RUN_POINTS; at++) {
    const uint32_t *held = NULL;
    size_t length = 0;
    if (spellings != NULL) {
      if (!growing_members(&spellings->runs, query->values + at, &held, &length)) { return 0; }
    } else {
      int64_t run = frozen_run(runs, query->values + at);
      if (run < 0) { return 0; }
      size_t start = runs->offsets[run];
      size_t end = runs->offsets[(size_t)run + 1];
      if (start >= end || end > runs->member_count) { return 0; }
      length = end - start;
      held = runs->members + start;
    }
    if (length < *count) {
      *count = length;
      *members = held;
    }
  }
  return *count != SIZE_MAX;
}

int partial_spelling(const narsil_expansion_segment *source, uint32_t entry, term_cursor *text, uint32_t *token,
                     size_t *length) {
  if (source->growing != NULL) {
    const narsil_spelling_table *spellings = source->growing->spellings;
    if (spellings == NULL || entry >= spellings->entries.strings.header[TERM_COUNT] ||
        spellings->entries.count[entry] == 0) {
      return 0;
    }
    const narsil_term_table *strings = &spellings->entries.strings;
    size_t start = strings->term_offset[entry];
    size_t size = strings->term_length[entry];
    size_t used = strings->header[TERM_UNITS_USED];
    if (start > used || size > used - start) { return 0; }
    *text = (term_cursor){strings->units, NULL, start, start + size};
    *token = spellings->entries.token[entry];
  } else {
    const narsil_frozen_strings *spellings = source->frozen->spellings;
    if (spellings == NULL || entry >= spellings->count ||
        spellings->counts[entry] <= source->state->removed_spellings[entry]) {
      return 0;
    }
    size_t start = spellings->offsets[entry];
    size_t end = spellings->offsets[(size_t)entry + 1];
    if (start > end || end > spellings->text_bytes) { return 0; }
    *text = (term_cursor){NULL, spellings->text, start, end};
    *token = source->frozen->spelling_tokens[entry];
  }
  return expansion_point_count(*text, length);
}
