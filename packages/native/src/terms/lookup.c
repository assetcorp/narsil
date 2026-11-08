#include "../../include/narsil_terms.h"

#include "../../include/narsil_core.h"
#include "../analysis/text.h"
#include "../regions.h"
#include "dictionary.h"
#include "matching.h"
#include "scratch.h"
#include "table.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

static int valid_outputs(const narsil_term_lookup *request, uint32_t *ordinals, size_t capacity, uint32_t *count) {
  enum { REQUEST_REGION = DICTIONARY_REGIONS, TEXT_REGION, INPUT_REGIONS };
  memory_region inputs[INPUT_REGIONS];
  memory_region output;
  memory_region size;
  if (request == NULL || request->text_length > TERM_TEXT_LIMIT || request->operation > NARSIL_LOOKUP_TYPO ||
      !dictionary_regions(request->dictionary, inputs) ||
      !region_of(request, 1, sizeof *request, &inputs[REQUEST_REGION]) ||
      !region_of(request->text, request->text_length, sizeof *request->text, &inputs[TEXT_REGION]) ||
      !region_of(ordinals, capacity, sizeof *ordinals, &output) || !region_of(count, 1, sizeof *count, &size) ||
      overlaps(output, size)) {
    return 0;
  }
  for (size_t at = 0; at < INPUT_REGIONS; at++) {
    if (overlaps(inputs[at], output) || overlaps(inputs[at], size)) { return 0; }
  }
  return 1;
}

static int64_t scan_exact(const narsil_term_dictionary *dictionary, const narsil_code_points *query) {
  uint32_t count = dictionary_count(dictionary);
  for (uint32_t ordinal = 0; ordinal < count; ordinal++) {
    term_cursor cursor;
    int valid = 0;
    if (dictionary_frequency(dictionary, ordinal) > 0 && dictionary_cursor(dictionary, ordinal, &cursor) &&
        term_compare_query(cursor, query, SIZE_MAX, &valid) == 0 && valid) {
      return ordinal;
    }
  }
  return -1;
}

static int64_t exact(const narsil_term_lookup *request, const narsil_code_points *query) {
  const narsil_term_dictionary *dictionary = request->dictionary;
  if (dictionary->growing != NULL) {
    int64_t found = term_table_find(dictionary->growing, request->text, request->text_length);
    return found >= 0 && dictionary_frequency(dictionary, (uint32_t)found) > 0 ? found : -1;
  }
  size_t low = 0;
  size_t high = dictionary_count(dictionary);
  while (low < high) {
    size_t middle = low + ((high - low) / 2);
    term_cursor cursor;
    if (!dictionary_cursor(dictionary, (uint32_t)middle, &cursor)) { return scan_exact(dictionary, query); }
    int valid = 0;
    int order = term_compare_query(cursor, query, SIZE_MAX, &valid);
    if (!valid) { return scan_exact(dictionary, query); }
    if (order == 0) { return dictionary_frequency(dictionary, (uint32_t)middle) > 0 ? (int64_t)middle : -1; }
    if (order < 0) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return -1;
}

static narsil_status match_failure(int status) {
  return status == -NARSIL_OUT_OF_MEMORY ? NARSIL_OUT_OF_MEMORY : NARSIL_INVALID_ARGUMENT;
}

static narsil_status collect_match(const narsil_term_lookup *request, term_scratch *scratch, uint32_t ordinal) {
  int matched = term_matches(request, scratch, ordinal);
  if (matched < 0) { return match_failure(matched); }
  if (matched == 1 && narsil_code_points_push(&scratch->results, ordinal) != NARSIL_OK) { return NARSIL_OUT_OF_MEMORY; }
  return NARSIL_OK;
}

static narsil_status collect(const narsil_term_lookup *request, term_scratch *scratch) {
  const narsil_term_dictionary *dictionary = request->dictionary;
  uint32_t count = dictionary_count(dictionary);
  const narsil_term_table *table = dictionary->growing;
  int chained = table != NULL && request->text_length > 0 &&
                (request->operation == NARSIL_LOOKUP_PREFIX || request->prefix_length > 0);
  uint32_t start = 0;
  uint32_t end = count;
  term_range(request, &scratch->query, &start, &end);
  uint32_t ordinal = chained ? table->first_unit_head[request->text[0]] : start;
  enum { WORD_BITS = 32, WORD_SHIFT = 5, WORD_MASK = 31 };
  if (chained) {
    size_t words = ((size_t)count + WORD_MASK) / WORD_BITS;
    if (narsil_code_points_reserve(&scratch->seen, words) != NARSIL_OK) { return NARSIL_OUT_OF_MEMORY; }
    if (words > 0) { memset(scratch->seen.values, 0, words * sizeof *scratch->seen.values); }
  }
  scratch->results.length = 0;
  for (uint32_t scanned = start; scanned < end; scanned++) {
    if (chained) {
      if (ordinal == 0 || ordinal > count) { break; }
      ordinal--;
      uint32_t mask = UINT32_C(1) << (ordinal & WORD_MASK);
      if ((scratch->seen.values[ordinal >> WORD_SHIFT] & mask) != 0) { break; }
      scratch->seen.values[ordinal >> WORD_SHIFT] |= mask;
    }
    narsil_status status = collect_match(request, scratch, ordinal);
    if (status != NARSIL_OK) { return status; }
    ordinal = chained ? table->first_unit_next[ordinal] : ordinal + 1;
  }
  return NARSIL_OK;
}

narsil_status narsil_lookup_terms(narsil_workspace *workspace, const narsil_term_lookup *request, uint32_t *ordinals,
                                  size_t capacity, uint32_t *count) {
  if (workspace == NULL || !valid_outputs(request, ordinals, capacity, count)) { return NARSIL_INVALID_ARGUMENT; }
  term_scratch *scratch = workspace_term_scratch(workspace);
  int exact_query = request->operation == NARSIL_LOOKUP_EXACT ||
                    (request->operation == NARSIL_LOOKUP_TYPO && request->tolerance == 0);
  if (!exact_query || request->dictionary->growing == NULL) {
    term_cursor query = {request->text, NULL, 0, request->text_length};
    int decoded = term_points(query, &scratch->query);
    if (decoded != 1) { return match_failure(decoded); }
  }
  if (exact_query) {
    int64_t found = exact(request, &scratch->query);
    if (found >= 0 && capacity == 0) { return NARSIL_NEEDS_ROOM; }
    if (found >= 0) { ordinals[0] = (uint32_t)found; }
    *count = found >= 0 ? 1 : 0;
    return NARSIL_OK;
  }
  if (request->operation == NARSIL_LOOKUP_PREFIX && (request->text_length == 0 || request->limit == 0)) {
    *count = 0;
    return NARSIL_OK;
  }
  narsil_status status = collect(request, scratch);
  if (status != NARSIL_OK) { return status; }
  size_t needed = scratch->results.length;
  if (request->operation == NARSIL_LOOKUP_PREFIX && request->limit < needed) { needed = request->limit; }
  if (needed > capacity) { return NARSIL_NEEDS_ROOM; }
  if (narsil_code_points_reserve(&scratch->spare, scratch->results.length) != NARSIL_OK) {
    return NARSIL_OUT_OF_MEMORY;
  }
  term_sort(request, scratch);
  if (needed > 0) { memcpy(ordinals, scratch->results.values, needed * sizeof *ordinals); }
  *count = (uint32_t)needed;
  return NARSIL_OK;
}

static int valid_batch(const narsil_term_dictionary *dictionary, const uint16_t *units, size_t unit_count,
                       const uint32_t *offsets, size_t offset_count, uint32_t *ordinals, size_t capacity) {
  enum { UNITS = DICTIONARY_REGIONS, OFFSETS, INPUT_REGIONS };
  memory_region inputs[INPUT_REGIONS];
  memory_region output;
  if (offset_count == 0 || offset_count - 1 > UINT32_MAX || unit_count > UINT32_MAX ||
      (uintptr_t)units % _Alignof(uint16_t) != 0 || (uintptr_t)offsets % _Alignof(uint32_t) != 0 ||
      (uintptr_t)ordinals % _Alignof(uint32_t) != 0 || !dictionary_regions(dictionary, inputs) ||
      !region_of(units, unit_count, sizeof *units, &inputs[UNITS]) ||
      !region_of(offsets, offset_count, sizeof *offsets, &inputs[OFFSETS]) ||
      !region_of(ordinals, capacity, sizeof *ordinals, &output)) {
    return 0;
  }
  for (size_t at = 0; at < INPUT_REGIONS; at++) {
    if (overlaps(inputs[at], output)) { return 0; }
  }
  if (offsets[0] != 0 || offsets[offset_count - 1] != unit_count) { return 0; }
  for (size_t at = 1; at < offset_count; at++) {
    if (offsets[at] < offsets[at - 1] || offsets[at] - offsets[at - 1] > TERM_TEXT_LIMIT) { return 0; }
  }
  return 1;
}

narsil_status narsil_lookup_exact_batch(narsil_workspace *workspace, const narsil_term_dictionary *dictionary,
                                        const uint16_t *units, size_t unit_count, const uint32_t *offsets,
                                        size_t offset_count, uint32_t *ordinals, size_t capacity) {
  if (workspace == NULL || !valid_batch(dictionary, units, unit_count, offsets, offset_count, ordinals, capacity)) {
    return NARSIL_INVALID_ARGUMENT;
  }
  size_t count = offset_count - 1;
  if (count > capacity) { return NARSIL_NEEDS_ROOM; }
  term_scratch *scratch = workspace_term_scratch(workspace);
  if (narsil_code_points_reserve(&scratch->results, count) != NARSIL_OK) { return NARSIL_OUT_OF_MEMORY; }
  for (size_t at = 0; at < count; at++) {
    const uint16_t *text = offsets[at] == 0 ? units : units + offsets[at];
    size_t length = offsets[at + 1] - offsets[at];
    if (dictionary->growing == NULL) {
      term_cursor query = {text, NULL, 0, length};
      int decoded = term_points(query, &scratch->query);
      if (decoded != 1) { return match_failure(decoded); }
    }
    narsil_term_lookup request = {.dictionary = dictionary, .text = text, .text_length = length};
    int64_t found = exact(&request, &scratch->query);
    scratch->results.values[at] = found < 0 ? UINT32_MAX : (uint32_t)found;
  }
  if (count > 0) { memcpy(ordinals, scratch->results.values, count * sizeof *ordinals); }
  return NARSIL_OK;
}

narsil_status narsil_document_frequency(const narsil_term_dictionary *dictionary, uint32_t token, uint32_t *frequency,
                                        size_t capacity) {
  memory_region inputs[DICTIONARY_REGIONS];
  memory_region output;
  if (!dictionary_regions(dictionary, inputs) || token >= dictionary_count(dictionary) ||
      !region_of(frequency, capacity, sizeof *frequency, &output)) {
    return NARSIL_INVALID_ARGUMENT;
  }
  for (size_t at = 0; at < DICTIONARY_REGIONS; at++) {
    if (overlaps(inputs[at], output)) { return NARSIL_INVALID_ARGUMENT; }
  }
  if (capacity == 0) { return NARSIL_NEEDS_ROOM; }
  frequency[0] = dictionary_frequency(dictionary, token);
  return NARSIL_OK;
}
