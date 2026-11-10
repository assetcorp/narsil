#include "internal.h"
#include "suggestions.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_expansion.h"
#include "../../include/narsil_suggestions.h"
#include "../../include/narsil_terms.h"

#include "../allocation.h"
#include "../analysis/text.h"
#include "../terms/dictionary.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

static int starts_with(term_cursor text, const uint16_t *prefix, size_t length) {
  term_cursor query = {prefix, NULL, 0, length};
  uint32_t point = 0;
  while (term_next(&query, &point) > 0) {
    uint32_t found = 0;
    if (term_next(&text, &found) <= 0 || point != found) { return 0; }
  }
  return 1;
}

static narsil_status reserve_surfaces(expansion_scratch *scratch, const narsil_expansion_segment *source) {
  if (source->growing != NULL) { return NARSIL_OK; }
  size_t count = source->frozen->terms.count;
  if (count > scratch->surface_capacity) {
    if (count > SIZE_MAX / sizeof *scratch->surface_occurrences) { return NARSIL_OUT_OF_MEMORY; }
    void *grown = core_reallocate(scratch->surface_occurrences, count * sizeof *scratch->surface_occurrences);
    if (grown == NULL) { return NARSIL_OUT_OF_MEMORY; }
    scratch->surface_occurrences = grown;
    scratch->surface_capacity = count;
  }
  if (count > 0) { memset(scratch->surface_occurrences, 0, count * sizeof *scratch->surface_occurrences); }
  return NARSIL_OK;
}

static narsil_status surfaces_of(narsil_workspace *workspace, expansion_scratch *scratch,
                                 const narsil_suggestion_request *request, uint32_t segment, int *holds_surfaces) {
  const narsil_expansion_segment *source = request->segments + segment;
  narsil_status status = reserve_surfaces(scratch, source);
  if (status != NARSIL_OK) { return status; }
  narsil_term_dictionary dictionary;
  if (!expansion_dictionary(source, &dictionary)) { return NARSIL_INVALID_ARGUMENT; }
  uint32_t length = expansion_surface_count(source);
  for (uint32_t at = 0; at < length; at++) {
    term_cursor spelling;
    term_cursor text;
    uint32_t occurrences = 0;
    if (!expansion_surface(source, at, &spelling, &text, &occurrences)) { continue; }
    *holds_surfaces = 1;
    uint32_t token = 0;
    uint32_t found = 0;
    status = expansion_find(workspace, scratch, source, text, &token, &found);
    if (status != NARSIL_OK) { return status; }
    if (found == 0) { continue; }
    if (source->growing == NULL) { scratch->surface_occurrences[token] += occurrences; }
    if (!starts_with(spelling, request->typed, request->typed_length)) { continue; }
    suggestion_entry entry = {text,
                              spelling,
                              segment,
                              token,
                              NARSIL_SUGGESTION_SURFACE,
                              at,
                              occurrences,
                              dictionary_frequency(&dictionary, token)};
    status = suggestion_append(&scratch->suggestions, entry);
    if (status != NARSIL_OK) { return status; }
  }
  return NARSIL_OK;
}

static narsil_status tokens_of(narsil_workspace *workspace, expansion_scratch *scratch,
                               const narsil_expansion_segment *source, uint32_t segment, const uint16_t *prefix,
                               size_t length) {
  narsil_term_dictionary dictionary;
  if (!expansion_dictionary(source, &dictionary)) { return NARSIL_INVALID_ARGUMENT; }
  size_t capacity = dictionary_count(&dictionary);
  int reserved = narsil_code_points_reserve(&scratch->matches, capacity);
  if (reserved != NARSIL_OK) { return (narsil_status)reserved; }
  narsil_term_lookup lookup = {.dictionary = &dictionary,
                               .text = prefix,
                               .text_length = length,
                               .operation = NARSIL_LOOKUP_PREFIX,
                               .limit = UINT32_MAX};
  uint32_t count = 0;
  narsil_status status = narsil_lookup_terms(workspace, &lookup, scratch->matches.values, capacity, &count);
  if (status != NARSIL_OK) { return status; }
  for (uint32_t at = 0; at < count; at++) {
    uint32_t token = scratch->matches.values[at];
    double surfaces = source->growing == NULL ? scratch->surface_occurrences[token] : 0;
    double occurrences = expansion_occurrences(source, token, surfaces);
    if (!(occurrences > 0)) { continue; }
    term_cursor text;
    size_t points = 0;
    if (!dictionary_cursor(&dictionary, token, &text) || !expansion_point_count(text, &points) || points == 0) {
      continue;
    }
    suggestion_entry entry = {text,
                              text,
                              segment,
                              token,
                              NARSIL_SUGGESTION_TOKEN,
                              token,
                              occurrences,
                              dictionary_frequency(&dictionary, token)};
    status = suggestion_append(&scratch->suggestions, entry);
    if (status != NARSIL_OK) { return status; }
  }
  return NARSIL_OK;
}

narsil_status suggestion_collect(narsil_workspace *workspace, expansion_scratch *scratch,
                                 const narsil_suggestion_request *request) {
  scratch->suggestions.count = 0;
  for (size_t at = 0; at < request->segment_count; at++) {
    int holds_surfaces = 0;
    narsil_status status = surfaces_of(workspace, scratch, request, (uint32_t)at, &holds_surfaces);
    if (status == NARSIL_OK) {
      status =
          tokens_of(workspace, scratch, request->segments + at, (uint32_t)at, request->typed, request->typed_length);
    }
    if (status == NARSIL_OK && !holds_surfaces && request->stemmed_length > 0 &&
        !narsil_units_equal(request->typed, request->typed_length, request->stemmed, request->stemmed_length)) {
      status = tokens_of(workspace, scratch, request->segments + at, (uint32_t)at, request->stemmed,
                         request->stemmed_length);
    }
    if (status != NARSIL_OK) { return status; }
  }
  return suggestion_rank(&scratch->suggestions);
}
