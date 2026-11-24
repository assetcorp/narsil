#include "table.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_expansion.h"
#include "../../include/narsil_folding.h"
#include "../analysis/text.h"
#include "../expansion/internal.h"
#include "../terms/dictionary.h"

#include <stddef.h>
#include <stdint.h>

enum { FOLD_BY_KEY, FOLD_BY_FOLD };

fold_text fold_entry_fold(const narsil_fold_table *table, const fold_entry *entry) {
  return (fold_text){table->units.units + entry->fold_start, entry->fold_length};
}

fold_text fold_entry_key(const narsil_fold_table *table, const fold_entry *entry) {
  return (fold_text){table->units.units + entry->key_start, entry->key_length};
}

int fold_compare_points(fold_text left, fold_text right) {
  size_t at_left = 0;
  size_t at_right = 0;
  while (at_left < left.length && at_right < right.length) {
    uint32_t first = narsil_decode_next(left.units, left.length, &at_left);
    uint32_t second = narsil_decode_next(right.units, right.length, &at_right);
    if (first != second) { return first < second ? -1 : 1; }
  }
  if (at_left < left.length) { return 1; }
  return at_right < right.length ? -1 : 0;
}

int fold_starts_with(fold_text text, fold_text prefix) {
  return prefix.length <= text.length && narsil_units_equal(text.units, prefix.length, prefix.units, prefix.length);
}

static fold_text ordered_text(const narsil_fold_table *table, int ordering, const fold_entry *entry) {
  return ordering == FOLD_BY_KEY ? fold_entry_key(table, entry) : fold_entry_fold(table, entry);
}

static int compare_entries(const narsil_fold_table *table, int ordering, uint32_t left, uint32_t right) {
  int order = fold_compare_points(ordered_text(table, ordering, table->entries + left),
                                  ordered_text(table, ordering, table->entries + right));
  if (order != 0) { return order; }
  return (left > right) - (left < right);
}

static void merge_runs(const narsil_fold_table *table, int ordering, uint32_t *source, uint32_t *target, size_t width) {
  size_t count = table->count;
  for (size_t start = 0; start < count; start += 2 * width) {
    size_t middle = start + width < count ? start + width : count;
    size_t end = start + (2 * width) < count ? start + (2 * width) : count;
    size_t left = start;
    size_t right = middle;
    for (size_t out = start; out < end; out++) {
      int takes_left =
          right >= end || (left < middle && compare_entries(table, ordering, source[left], source[right]) <= 0);
      target[out] = takes_left ? source[left++] : source[right++];
    }
  }
}

static void sort_order(narsil_fold_table *table, int ordering, uint32_t *order) {
  for (size_t at = 0; at < table->count; at++) { order[at] = (uint32_t)at; }
  uint32_t *source = order;
  uint32_t *target = table->order_scratch;
  for (size_t width = 1; width < table->count; width *= 2) {
    merge_runs(table, ordering, source, target, width);
    uint32_t *swap = source;
    source = target;
    target = swap;
  }
  if (source != order) {
    for (size_t at = 0; at < table->count; at++) { order[at] = source[at]; }
  }
}

narsil_status fold_table_sort(narsil_fold_table *table) {
  if (table->count == 0) { return NARSIL_OK; }
  sort_order(table, FOLD_BY_KEY, table->by_key);
  sort_order(table, FOLD_BY_FOLD, table->by_fold);
  return NARSIL_OK;
}

static size_t lower_bound(const narsil_fold_table *table, const uint32_t *order, int ordering, fold_text wanted) {
  size_t low = 0;
  size_t high = table->count;
  while (low < high) {
    size_t middle = low + ((high - low) / 2);
    if (fold_compare_points(ordered_text(table, ordering, table->entries + order[middle]), wanted) < 0) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

size_t fold_lower_key(const narsil_fold_table *table, fold_text key) {
  return lower_bound(table, table->by_key, FOLD_BY_KEY, key);
}

size_t fold_lower_fold(const narsil_fold_table *table, fold_text fold) {
  return lower_bound(table, table->by_fold, FOLD_BY_FOLD, fold);
}

static double frozen_surface_occurrences(const narsil_fold_table *table, const fold_entry *entry,
                                         const narsil_expansion_segment *segment) {
  double total = 0;
  for (size_t at = entry->surfaces_start; at < (size_t)entry->surfaces_start + entry->surfaces_count; at++) {
    term_cursor spelling;
    term_cursor token;
    uint32_t count = 0;
    if (expansion_surface(segment, table->token_surfaces[at], &spelling, &token, &count)) { total += count; }
  }
  return total;
}

int fold_entry_held(const narsil_fold_table *table, const fold_entry *entry, const narsil_expansion_segment *segment) {
  term_cursor spelling;
  term_cursor token;
  uint32_t count = 0;
  size_t length = 0;
  uint32_t owner = 0;
  switch (entry->kind) {
    case FOLD_TOKEN: {
      double surfaces = segment->growing == NULL ? frozen_surface_occurrences(table, entry, segment) : 0;
      return expansion_occurrences(segment, entry->token, surfaces) > 0;
    }
    case FOLD_SURFACE:
      return expansion_surface(segment, entry->entry, &spelling, &token, &count);
    default:
      return partial_spelling(segment, entry->entry, &spelling, &owner, &length) && owner == entry->token;
  }
}
