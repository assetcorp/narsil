#include "internal.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_frozen_segments.h"
#include "../../include/narsil_segment_merge.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

static int key_order(const merge_string *first, const merge_string *second, int partial) {
  int order = segment_merge_compare_text(first->spelling, second->spelling);
  return order == 0 && partial ? segment_merge_compare_text(first->token, second->token) : order;
}

static int compare(const merge_string *first, const merge_string *second, int partial) {
  int order = key_order(first, second, partial);
  if (order != 0) { return order; }
  if (first->source != second->source) { return first->source < second->source ? -1 : 1; }
  return first->ordinal < second->ordinal ? -1 : first->ordinal > second->ordinal;
}

static int compare_surfaces(const void *left, const void *right) { return compare(left, right, 0); }
static int compare_spellings(const void *left, const void *right) { return compare(left, right, 1); }

static int keeps_token(const segment_merge_scratch *scratch, merge_text token) {
  size_t low = 0;
  size_t high = scratch->term_count;
  while (low < high) {
    size_t middle = low + ((high - low) / 2);
    int order = segment_merge_compare_text(scratch->terms[middle].text, token);
    if (order == 0) { return scratch->terms[middle].target != UINT32_MAX; }
    if (order < 0) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return 0;
}

static size_t collect(segment_merge_scratch *scratch, const narsil_keyword_merge_request *request,
                      merge_string *entries, int partial) {
  size_t count = 0;
  for (size_t at = 0; at < request->input_count; at++) {
    const narsil_keyword_merge_input *input = request->inputs + at;
    const narsil_frozen_strings *strings = partial ? input->spellings : input->surfaces;
    if (strings == NULL) { continue; }
    for (size_t ordinal = 0; ordinal < strings->count; ordinal++) {
      merge_text spelling;
      merge_text token;
      if (strings->counts[ordinal] == 0 || !segment_merge_text(strings, ordinal * 2, &spelling) ||
          !segment_merge_text(strings, (ordinal * 2) + 1, &token) || (partial && !keeps_token(scratch, token))) {
        continue;
      }
      entries[count++] = (merge_string){spelling, token, strings->counts[ordinal], at, (uint32_t)ordinal};
    }
  }
  return count;
}

static narsil_status reserve_strings(segment_merge_scratch *scratch, const narsil_keyword_merge_request *request,
                                     int partial) {
  size_t needed = 0;
  for (size_t at = 0; at < request->input_count; at++) {
    const narsil_frozen_strings *strings = partial ? request->inputs[at].spellings : request->inputs[at].surfaces;
    size_t count = strings == NULL ? 0 : strings->count;
    if (count > SIZE_MAX - needed) { return NARSIL_OUT_OF_MEMORY; }
    needed += count;
  }
  void *allocation = partial ? scratch->spellings : scratch->surfaces;
  size_t *capacity = partial ? &scratch->spelling_capacity : &scratch->surface_capacity;
  narsil_status status = segment_merge_reserve(&allocation, needed, capacity, sizeof(merge_string));
  if (partial) {
    scratch->spellings = allocation;
  } else {
    scratch->surfaces = allocation;
  }
  return status;
}

static narsil_status merge_strings(segment_merge_scratch *scratch, const narsil_keyword_merge_request *request,
                                   int partial) {
  narsil_status status = reserve_strings(scratch, request, partial);
  if (status != NARSIL_OK) { return status; }
  merge_string *entries = partial ? scratch->spellings : scratch->surfaces;
  size_t count = collect(scratch, request, entries, partial);
  if (count > 1) { qsort(entries, count, sizeof *entries, partial ? compare_spellings : compare_surfaces); }
  size_t kept = 0;
  uint32_t bytes = 0;
  for (size_t at = 0; at < count;) {
    merge_string entry = entries[at++];
    while (at < count && key_order(&entry, entries + at, partial) == 0) {
      if (entries[at].count > UINT32_MAX - entry.count) { return NARSIL_SEGMENT_FULL; }
      entry.count += entries[at++].count;
    }
    if (entry.spelling.length > UINT32_MAX - bytes) { return NARSIL_INVALID_ARGUMENT; }
    bytes += (uint32_t)entry.spelling.length;
    if (entry.token.length > UINT32_MAX - bytes || kept == UINT32_MAX) { return NARSIL_INVALID_ARGUMENT; }
    bytes += (uint32_t)entry.token.length;
    entries[kept++] = entry;
  }
  if (partial) {
    scratch->spelling_count = kept;
    scratch->sizes.spellings = (uint32_t)kept;
    scratch->sizes.spelling_bytes = bytes;
  } else {
    scratch->surface_count = kept;
    scratch->sizes.surfaces = (uint32_t)kept;
    scratch->sizes.surface_bytes = bytes;
  }
  return NARSIL_OK;
}

narsil_status segment_merge_strings(segment_merge_scratch *scratch, const narsil_keyword_merge_request *request) {
  narsil_status status = merge_strings(scratch, request, 0);
  return status == NARSIL_OK ? merge_strings(scratch, request, 1) : status;
}
