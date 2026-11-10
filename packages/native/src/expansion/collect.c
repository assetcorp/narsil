#include "internal.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_expansion.h"
#include "../../include/narsil_terms.h"
#include "../analysis/text.h"
#include "../terms/dictionary.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

narsil_status expansion_find(narsil_workspace *workspace, expansion_scratch *scratch,
                             const narsil_expansion_segment *source, term_cursor text, uint32_t *token,
                             uint32_t *found) {
  narsil_term_dictionary dictionary;
  if (!expansion_dictionary(source, &dictionary)) { return NARSIL_INVALID_ARGUMENT; }
  int status = expansion_cursor_text(text, &scratch->text);
  if (status == NARSIL_INVALID_ARGUMENT) {
    *found = 0;
    return NARSIL_OK;
  }
  if (status != NARSIL_OK) { return (narsil_status)status; }
  narsil_term_lookup request = {.dictionary = &dictionary,
                                .text = scratch->text.units,
                                .text_length = scratch->text.length,
                                .operation = NARSIL_LOOKUP_EXACT};
  return narsil_lookup_terms(workspace, &request, token, 1, found);
}

static int starts_with(term_cursor text, const uint16_t *prefix, size_t length) {
  size_t count = 0;
  if (!expansion_point_count(text, &count)) { return 0; }
  term_cursor query = {prefix, NULL, 0, length};
  uint32_t point = 0;
  while (term_next(&query, &point) > 0) {
    uint32_t found = 0;
    if (term_next(&text, &found) <= 0 || found != point) { return 0; }
  }
  return 1;
}

static int holds_surfaces(const narsil_prefix_request *request) {
  for (size_t at = 0; at < request->segment_count; at++) {
    const narsil_expansion_segment *source = request->segments + at;
    uint32_t entries = expansion_surface_count(source);
    for (uint32_t entry = 0; entry < entries; entry++) {
      term_cursor spelling;
      term_cursor token;
      uint32_t count = 0;
      if (expansion_surface(source, entry, &spelling, &token, &count)) { return 1; }
    }
  }
  return 0;
}

static narsil_status reserve_surfaces(expansion_scratch *scratch, const narsil_expansion_segment *source) {
  if (source->growing != NULL) { return NARSIL_OK; }
  size_t count = source->frozen->terms.count;
  if (count > scratch->surface_capacity) {
    if (count > SIZE_MAX / sizeof *scratch->surface_occurrences) { return NARSIL_OUT_OF_MEMORY; }
    void *grown = realloc(scratch->surface_occurrences, count * sizeof *scratch->surface_occurrences);
    if (grown == NULL) { return NARSIL_OUT_OF_MEMORY; }
    scratch->surface_occurrences = grown;
    scratch->surface_capacity = count;
  }
  if (count > 0) { memset(scratch->surface_occurrences, 0, count * sizeof *scratch->surface_occurrences); }
  return NARSIL_OK;
}

static narsil_status collect_surfaces(narsil_workspace *workspace, expansion_scratch *scratch,
                                      const narsil_prefix_request *request, uint32_t source_index) {
  const narsil_expansion_segment *source = request->segments + source_index;
  narsil_status status = reserve_surfaces(scratch, source);
  if (status != NARSIL_OK) { return status; }
  uint32_t entries = expansion_surface_count(source);
  for (uint32_t entry = 0; entry < entries; entry++) {
    term_cursor spelling;
    term_cursor text;
    uint32_t occurrences = 0;
    if (!expansion_surface(source, entry, &spelling, &text, &occurrences)) { continue; }
    int matches = starts_with(spelling, request->typed, request->typed_length);
    if (!matches && source->growing != NULL) { continue; }
    uint32_t token = 0;
    uint32_t found = 0;
    status = expansion_find(workspace, scratch, source, text, &token, &found);
    if (status != NARSIL_OK) { return status; }
    if (found == 0) { continue; }
    if (source->growing == NULL) { scratch->surface_occurrences[token] += occurrences; }
    if (matches) {
      status = expansion_add(scratch, source, source_index, token, 0);
      if (status != NARSIL_OK) { return status; }
    }
  }
  return NARSIL_OK;
}

static narsil_status collect_tokens(narsil_workspace *workspace, expansion_scratch *scratch,
                                    const narsil_expansion_segment *source, uint32_t source_index,
                                    const uint16_t *prefix, size_t length) {
  narsil_term_dictionary dictionary;
  if (!expansion_dictionary(source, &dictionary)) { return NARSIL_INVALID_ARGUMENT; }
  size_t capacity = dictionary_count(&dictionary);
  int reserved = narsil_code_points_reserve(&scratch->matches, capacity);
  if (reserved != NARSIL_OK) { return (narsil_status)reserved; }
  narsil_term_lookup request = {.dictionary = &dictionary,
                                .text = prefix,
                                .text_length = length,
                                .operation = NARSIL_LOOKUP_PREFIX,
                                .limit = UINT32_MAX};
  uint32_t count = 0;
  narsil_status status = narsil_lookup_terms(workspace, &request, scratch->matches.values, capacity, &count);
  if (status != NARSIL_OK) { return status; }
  for (uint32_t at = 0; at < count; at++) {
    uint32_t token = scratch->matches.values[at];
    double surfaces = source->growing == NULL ? scratch->surface_occurrences[token] : 0;
    if (!(expansion_occurrences(source, token, surfaces) > 0)) { continue; }
    status = expansion_add(scratch, source, source_index, token, 0);
    if (status != NARSIL_OK) { return status; }
  }
  return NARSIL_OK;
}

narsil_status expansion_collect(narsil_workspace *workspace, expansion_scratch *scratch,
                                const narsil_prefix_request *request) {
  int fallback = !holds_surfaces(request) && request->stemmed_length > 0 &&
                 !narsil_units_equal(request->typed, request->typed_length, request->stemmed, request->stemmed_length);
  scratch->count = 0;
  for (size_t at = 0; at < request->segment_count; at++) {
    narsil_status status = collect_surfaces(workspace, scratch, request, (uint32_t)at);
    if (status == NARSIL_OK) {
      status = collect_tokens(workspace, scratch, request->segments + at, (uint32_t)at, request->typed,
                              request->typed_length);
    }
    if (status == NARSIL_OK && fallback) {
      status = collect_tokens(workspace, scratch, request->segments + at, (uint32_t)at, request->stemmed,
                              request->stemmed_length);
    }
    if (status != NARSIL_OK) { return status; }
  }
  return NARSIL_OK;
}
