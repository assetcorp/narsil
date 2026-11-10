#include "scratch.h"

#include "../../include/narsil_analysis.h"
#include "../../include/narsil_core.h"
#include "../../include/narsil_highlight.h"
#include "../analysis/analyser.h"
#include "../analysis/languages.h"
#include "../analysis/split.h"
#include "../analysis/text.h"
#include "../terms/dictionary.h"
#include "../terms/matching.h"

#include <stddef.h>
#include <stdint.h>

static int starts_with(narsil_highlight_text text, narsil_highlight_text prefix) {
  return prefix.length <= text.length && narsil_units_equal(text.units, prefix.length, prefix.units, prefix.length);
}

static int contains_word(highlight_scratch *scratch, narsil_highlight_text text, narsil_highlight_text part) {
  if (part.length >= text.length) { return 0; }
  if (part.length == 0) { return 1; }
  int status = narsil_code_points_reserve(&scratch->distance.rows, part.length);
  if (status != NARSIL_OK) { return -status; }
  uint32_t *failure = scratch->distance.rows.values;
  failure[0] = 0;
  size_t matched = 0;
  for (size_t at = 1; at < part.length; at++) {
    while (matched > 0 && part.units[at] != part.units[matched]) { matched = failure[matched - 1]; }
    if (part.units[at] == part.units[matched]) { matched++; }
    failure[at] = (uint32_t)matched;
  }
  matched = 0;
  for (size_t at = 0; at < text.length; at++) {
    while (matched > 0 && text.units[at] != part.units[matched]) { matched = failure[matched - 1]; }
    if (text.units[at] == part.units[matched]) { matched++; }
    if (matched == part.length) { return 1; }
  }
  return 0;
}

static int contains_partial(highlight_scratch *scratch, narsil_highlight_text text,
                            const narsil_highlight_query *query) {
  for (size_t word = 0; word < query->partial_count; word++) {
    int status = contains_word(scratch, text, query->partial_words[word]);
    if (status != 0) { return status; }
  }
  return 0;
}

static int matches_stem(highlight_scratch *scratch, narsil_unit_view stem, const narsil_highlight_query *query) {
  for (size_t at = 0; at < query->synonym_count; at++) {
    narsil_highlight_text synonym = query->synonyms[at];
    if (narsil_units_equal(stem.units, stem.length, synonym.units, synonym.length)) { return 1; }
  }
  term_cursor candidate = {stem.units, NULL, 0, stem.length};
  int status = term_points(candidate, &scratch->distance.candidate);
  if (status != 1) { return status == 0 ? -NARSIL_INVALID_ARGUMENT : status; }
  for (size_t at = 0; at < query->term_count; at++) {
    narsil_highlight_term term = query->terms[at];
    status = term_points((term_cursor){term.text.units, NULL, 0, term.text.length}, &scratch->distance.query);
    if (status != 1) { return status == 0 ? -NARSIL_INVALID_ARGUMENT : status; }
    int valid = 0;
    size_t prefix = query->prefix_length;
    if (prefix > scratch->distance.query.length) { prefix = scratch->distance.query.length; }
    if (term_compare_query(candidate, &scratch->distance.query, prefix, &valid) != 0 || !valid) { continue; }
    status = term_within_distance(&scratch->distance, term.tolerance);
    if (status != 0) { return status; }
  }
  return 0;
}

static narsil_status mark_token(highlight_scratch *scratch, const narsil_token *token, int ascii) {
  narsil_span span = {token->original_offset, token->original_length};
  if (span.length == 0) { return NARSIL_OK; }
  if (!ascii) {
    if (span.start > scratch->offsets.length || span.length > scratch->offsets.length - span.start) {
      return NARSIL_INVALID_ARGUMENT;
    }
    uint32_t start = UINT32_MAX;
    uint32_t end = 0;
    for (size_t at = span.start; at < (size_t)span.start + span.length; at++) {
      narsil_span original = scratch->offsets.spans[at];
      if (original.start < start) { start = original.start; }
      if (original.start + original.length > end) { end = original.start + original.length; }
    }
    span = (narsil_span){start, end - start};
  }
  return (narsil_status)narsil_spans_push(&scratch->marked, span);
}

static narsil_status match_tokens(narsil_analyser *analyser, highlight_scratch *scratch,
                                  const narsil_highlight_request *request, int ascii) {
  narsil_analysis_request analysis = {request->language, NULL, 0, request->text.units, (uint32_t)request->text.length};
  narsil_tokens tokens;
  narsil_status status = narsil_analyse(analyser, &analysis, &tokens);
  for (uint32_t at = 0; status == NARSIL_OK && at < tokens.token_count; at++) {
    const narsil_token *token = tokens.tokens + at;
    narsil_highlight_text field = {tokens.units + token->term_offset, token->term_length};
    int matches = request->query.prefix.units != NULL && starts_with(field, request->query.prefix);
    if (!matches) {
      narsil_unit_view stem;
      status = (narsil_status)narsil_stem_token(analyser, narsil_language_table[request->language], request->language,
                                                (narsil_unit_view){field.units, field.length}, &stem);
      if (status != NARSIL_OK) { return status; }
      matches = matches_stem(scratch, stem, &request->query);
      if (matches < 0) { return (narsil_status)-matches; }
    }
    if (matches) { status = mark_token(scratch, token, ascii); }
  }
  return status;
}

narsil_status highlight_matches(narsil_analyser *analyser, highlight_scratch *scratch,
                                const narsil_highlight_request *request) {
  scratch->marked.length = 0;
  int ascii = narsil_units_are_ascii(request->text.units, request->text.length);
  narsil_status status = ascii ? NARSIL_OK : highlight_offsets(scratch, request->text.units, request->text.length);
  if (status == NARSIL_OK) { status = match_tokens(analyser, scratch, request, ascii); }
  if (status != NARSIL_OK || request->query.partial_count == 0) { return status; }
  narsil_analysis_request analysis = {
      request->language, NULL, NARSIL_ANALYSE_STEM | NARSIL_ANALYSE_COLLECT_SURFACES | NARSIL_ANALYSE_REMOVE_STOP_WORDS,
      request->text.units, (uint32_t)request->text.length};
  narsil_tokens tokens;
  status = narsil_analyse(analyser, &analysis, &tokens);
  for (uint32_t at = 0; status == NARSIL_OK && at < tokens.token_count; at++) {
    const narsil_token *token = tokens.tokens + at;
    uint32_t start = token->surface_offset == NARSIL_NO_SURFACE ? token->term_offset : token->surface_offset;
    uint32_t length = token->surface_offset == NARSIL_NO_SURFACE ? token->term_length : token->surface_length;
    int matches = contains_partial(scratch, (narsil_highlight_text){tokens.units + start, length}, &request->query);
    if (matches < 0) { return (narsil_status)-matches; }
    if (matches) { status = mark_token(scratch, token, ascii); }
  }
  return status;
}
