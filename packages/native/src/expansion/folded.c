#include "folded.h"
#include "internal.h"

#include "../../include/narsil_analysis.h"
#include "../../include/narsil_core.h"
#include "../../include/narsil_expansion.h"
#include "../../include/narsil_folding.h"
#include "../../include/narsil_terms.h"
#include "../allocation.h"
#include "../analysis/text.h"
#include "../folding/table.h"
#include "../terms/dictionary.h"
#include "../terms/matching.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

enum { FOLDED_VARIANT_BUDGET = 50, FOLDED_BLOCKS_PER_WORD = 2 };

typedef struct {
  expansion_candidate *values;
  size_t count;
} held_candidates;

typedef struct {
  narsil_code_points segments;
  narsil_code_points tokens;
} folded_rows;

static term_cursor units_cursor(const uint16_t *units, size_t length) { return (term_cursor){units, NULL, 0, length}; }

static int is_excluded(const narsil_folded_word *word, term_cursor text) {
  if (expansion_compare(text, units_cursor(word->own, word->own_length)) == 0) { return 1; }
  for (size_t at = 0; at < word->excluded_count; at++) {
    const narsil_term *excluded = word->excluded + at;
    if (expansion_compare(text, units_cursor(excluded->units, excluded->length)) == 0) { return 1; }
  }
  return 0;
}

static int is_variant(const held_candidates *variants, term_cursor text) {
  for (size_t at = 0; at < variants->count; at++) {
    if (expansion_compare(text, variants->values[at].text) == 0) { return 1; }
  }
  return 0;
}

static void drop_excluded(expansion_scratch *scratch, const narsil_folded_word *word, const held_candidates *variants) {
  size_t kept = 0;
  for (size_t at = 0; at < scratch->count; at++) {
    term_cursor text = scratch->candidates[at].text;
    if (is_excluded(word, text) || (variants != NULL && is_variant(variants, text))) { continue; }
    scratch->candidates[kept++] = scratch->candidates[at];
  }
  scratch->count = kept;
}

static int compare_text(const void *first, const void *second) {
  const expansion_candidate *left = first;
  const expansion_candidate *right = second;
  return expansion_compare(left->text, right->text);
}

typedef struct {
  size_t first;
  size_t end;
} key_span;

static narsil_status add_entry_tokens(expansion_scratch *scratch, const narsil_fold_table *table, key_span span,
                                      const narsil_expansion_segment *source, uint32_t segment) {
  for (size_t at = span.first; at < span.end; at++) {
    const fold_entry *entry = table->entries + table->by_key[at];
    if (entry->kind == FOLD_SPELLING || !fold_entry_held(table, entry, source)) { continue; }
    narsil_status status = expansion_add(scratch, source, segment, entry->token, 0);
    if (status != NARSIL_OK) { return status; }
  }
  return NARSIL_OK;
}

static key_span span_of_key(const narsil_fold_table *table, size_t first, fold_text key) {
  size_t end = first;
  while (end < table->count &&
         fold_compare_points(fold_entry_key(table, table->entries + table->by_key[end]), key) == 0) {
    end++;
  }
  return (key_span){first, end};
}

static narsil_status collect_variants(narsil_workspace *workspace, expansion_scratch *scratch,
                                      const narsil_folded_request *request, const narsil_folded_word *word) {
  scratch->count = 0;
  fold_text key = {word->key, word->key_length};
  for (size_t at = 0; at < request->segment_count; at++) {
    const narsil_fold_table *table = request->tables[at];
    const narsil_expansion_segment *source = request->segments + at;
    key_span span = span_of_key(table, fold_lower_key(table, key), key);
    narsil_status status = add_entry_tokens(scratch, table, span, source, (uint32_t)at);
    uint32_t token = 0;
    uint32_t found = 0;
    if (status == NARSIL_OK) {
      status = expansion_find(workspace, scratch, source, units_cursor(word->key, word->key_length), &token, &found);
    }
    if (status == NARSIL_OK && found != 0) { status = expansion_add(scratch, source, (uint32_t)at, token, 0); }
    if (status != NARSIL_OK) { return status; }
  }
  drop_excluded(scratch, word, NULL);
  narsil_prefix_request ranked = {.segments = request->segments, .segment_count = request->segment_count};
  narsil_status status = expansion_rank(workspace, scratch, &ranked);
  if (status != NARSIL_OK) { return status; }
  if (scratch->count > FOLDED_VARIANT_BUDGET) { scratch->count = FOLDED_VARIANT_BUDGET; }
  if (scratch->count > 1) { qsort(scratch->candidates, scratch->count, sizeof *scratch->candidates, compare_text); }
  return NARSIL_OK;
}

static int key_is_near(expansion_scratch *scratch, const narsil_folded_word *word, fold_text key, size_t prefix) {
  term_cursor cursor = units_cursor(key.units, key.length);
  int valid = 0;
  if (term_compare_query(cursor, &scratch->typo.query, prefix, &valid) != 0 || !valid) { return 0; }
  int status = term_points(cursor, &scratch->typo.candidate);
  if (status != 1) { return status; }
  return term_within_distance(&scratch->typo, word->tolerance);
}

static size_t shared_units(const narsil_folded_word *word, size_t prefix) {
  size_t index = 0;
  for (size_t points = 0; points < prefix && index < word->key_length; points++) {
    (void)narsil_decode_next(word->key, word->key_length, &index);
  }
  return index;
}

static narsil_status near_table_keys(expansion_scratch *scratch, const narsil_folded_word *word, size_t prefix,
                                     const narsil_fold_table *table, const narsil_expansion_segment *source,
                                     uint32_t segment) {
  fold_text shared = {word->key, shared_units(word, prefix)};
  for (size_t at = fold_lower_key(table, shared); at < table->count;) {
    fold_text key = fold_entry_key(table, table->entries + table->by_key[at]);
    if (!fold_starts_with(key, shared)) { break; }
    key_span span = span_of_key(table, at, key);
    int near = key_is_near(scratch, word, key, prefix);
    if (near < 0) { return (narsil_status)-near; }
    if (near) {
      narsil_status status = add_entry_tokens(scratch, table, span, source, segment);
      if (status != NARSIL_OK) { return status; }
    }
    at = span.end;
  }
  return NARSIL_OK;
}

static narsil_status near_dictionary_tokens(narsil_workspace *workspace, expansion_scratch *scratch,
                                            const narsil_folded_word *word, const narsil_expansion_segment *source,
                                            uint32_t segment) {
  narsil_term_dictionary dictionary;
  if (!expansion_dictionary(source, &dictionary)) { return NARSIL_INVALID_ARGUMENT; }
  size_t capacity = dictionary_count(&dictionary);
  int reserved = narsil_code_points_reserve(&scratch->matches, capacity);
  if (reserved != NARSIL_OK) { return (narsil_status)reserved; }
  narsil_term_lookup lookup = {.dictionary = &dictionary,
                               .text = word->key,
                               .text_length = word->key_length,
                               .operation = NARSIL_LOOKUP_TYPO,
                               .limit = UINT32_MAX,
                               .tolerance = word->tolerance,
                               .prefix_length = word->prefix_length};
  uint32_t count = 0;
  narsil_status status = narsil_lookup_terms(workspace, &lookup, scratch->matches.values, capacity, &count);
  for (uint32_t at = 0; status == NARSIL_OK && at < count; at++) {
    status = expansion_add(scratch, source, segment, scratch->matches.values[at], 0);
  }
  return status;
}

static narsil_status collect_typos(narsil_workspace *workspace, expansion_scratch *scratch,
                                   const narsil_folded_request *request, const narsil_folded_word *word,
                                   const held_candidates *variants) {
  scratch->count = 0;
  if (word->tolerance == 0) { return NARSIL_OK; }
  int status = term_points(units_cursor(word->key, word->key_length), &scratch->typo.query);
  if (status != 1) { return status == 0 ? NARSIL_INVALID_ARGUMENT : (narsil_status)-status; }
  size_t prefix = word->prefix_length < scratch->typo.query.length ? word->prefix_length : scratch->typo.query.length;
  int differs = !narsil_units_equal(word->key, word->key_length, word->own, word->own_length);
  for (size_t at = 0; at < request->segment_count; at++) {
    const narsil_expansion_segment *source = request->segments + at;
    narsil_status collected = near_table_keys(scratch, word, prefix, request->tables[at], source, (uint32_t)at);
    if (collected == NARSIL_OK && differs) {
      collected = near_dictionary_tokens(workspace, scratch, word, source, (uint32_t)at);
    }
    if (collected != NARSIL_OK) { return collected; }
  }
  drop_excluded(scratch, word, variants);
  narsil_prefix_request ranked = {.segments = request->segments, .segment_count = request->segment_count};
  narsil_status ranked_status = expansion_rank(workspace, scratch, &ranked);
  if (ranked_status != NARSIL_OK) { return ranked_status; }
  if (scratch->count > 1) { qsort(scratch->candidates, scratch->count, sizeof *scratch->candidates, compare_text); }
  return NARSIL_OK;
}

static narsil_status append_rows(folded_rows *rows, const expansion_scratch *scratch) {
  for (size_t at = 0; at < scratch->count; at++) {
    int status = narsil_code_points_push(&rows->segments, scratch->candidates[at].segment);
    if (status == NARSIL_OK) { status = narsil_code_points_push(&rows->tokens, scratch->candidates[at].token); }
    if (status != NARSIL_OK) { return (narsil_status)status; }
  }
  return NARSIL_OK;
}

static narsil_status keep_variants(held_candidates *variants, const expansion_scratch *scratch) {
  variants->count = 0;
  if (scratch->count == 0) { return NARSIL_OK; }
  expansion_candidate *held = core_reallocate(variants->values, scratch->count * sizeof *held);
  if (held == NULL) { return NARSIL_OUT_OF_MEMORY; }
  for (size_t at = 0; at < scratch->count; at++) { held[at] = scratch->candidates[at]; }
  variants->values = held;
  variants->count = scratch->count;
  return NARSIL_OK;
}

static narsil_status expand_words(narsil_workspace *workspace, const narsil_folded_request *request, folded_rows *rows,
                                  uint32_t *starts) {
  expansion_scratch *scratch = workspace_expansion_scratch(workspace);
  held_candidates variants = {NULL, 0};
  narsil_status status = NARSIL_OK;
  starts[0] = 0;
  for (size_t at = 0; status == NARSIL_OK && at < request->word_count; at++) {
    const narsil_folded_word *word = request->words + at;
    status = collect_variants(workspace, scratch, request, word);
    if (status == NARSIL_OK) { status = append_rows(rows, scratch); }
    if (status == NARSIL_OK) { status = keep_variants(&variants, scratch); }
    starts[(at * FOLDED_BLOCKS_PER_WORD) + 1] = (uint32_t)rows->tokens.length;
    if (status == NARSIL_OK) { status = collect_typos(workspace, scratch, request, word, &variants); }
    if (status == NARSIL_OK) { status = append_rows(rows, scratch); }
    starts[(at * FOLDED_BLOCKS_PER_WORD) + 2] = (uint32_t)rows->tokens.length;
  }
  free(variants.values);
  return status;
}

narsil_status narsil_expand_folded_terms(narsil_workspace *workspace, const narsil_folded_request *request,
                                         const narsil_folded_output *output, uint32_t *count) {
  if (workspace == NULL || !folded_regions(request, output, count)) { return NARSIL_INVALID_ARGUMENT; }
  size_t blocks = (request->word_count * FOLDED_BLOCKS_PER_WORD) + 1;
  if (output->start_capacity < blocks) { return NARSIL_NEEDS_ROOM; }
  expansion_scratch *scratch = workspace_expansion_scratch(workspace);
  int reserved = narsil_code_points_reserve(&scratch->starts, blocks);
  if (reserved != NARSIL_OK) { return (narsil_status)reserved; }
  folded_rows rows = {{NULL, 0, 0}, {NULL, 0, 0}};
  narsil_status status = expand_words(workspace, request, &rows, scratch->starts.values);
  size_t needed = rows.tokens.length;
  if (status == NARSIL_OK && (needed > output->segment_capacity || needed > output->token_capacity)) {
    status = NARSIL_NEEDS_ROOM;
  }
  if (status == NARSIL_OK) {
    for (size_t at = 0; at < needed; at++) {
      output->segments[at] = rows.segments.values[at];
      output->tokens[at] = rows.tokens.values[at];
    }
    for (size_t at = 0; at < blocks; at++) { output->starts[at] = scratch->starts.values[at]; }
    *count = (uint32_t)needed;
  }
  narsil_code_points_release(&rows.segments);
  narsil_code_points_release(&rows.tokens);
  return status;
}
