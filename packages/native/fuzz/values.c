#include "input.h"
#include "stored_values.h"

#include "../include/narsil_core.h"
#include "../include/narsil_facets.h"
#include "../include/narsil_groups.h"
#include "../include/narsil_math.h"
#include "../include/narsil_sort.h"
#include "../include/narsil_stored_values.h"

#include <stddef.h>
#include <stdint.h>

enum {
  MAX_DOCUMENTS = 64,
  MAX_OPERATIONS = 6,
  MAX_RANGES = 6,
  MAX_OUTPUT = 80,
  MAX_ENUM_VALUES = 12,
  MAX_POSTINGS = 128,
  MAX_GROUP_FIELDS = 3,
  MAX_HITS = 48,
  MAX_MATH_VALUES = 32,
  SORT_MODES = NARSIL_SORT_MEDIAN + 2,
  MATH_FUNCTIONS = NARSIL_MATH_FUNCTION_COUNT + 1,
  MAX_PER_GROUP_CHOICES = 6,
  LIMIT_FLAG_CHOICES = 3
};

enum {
  STORED_RANGE,
  VALUE_FACET,
  ENUM_FACET,
  NUMBER_FACET,
  RANGE_FACET,
  BOOLEAN_FACET,
  GROUP,
  SORT_VALUE,
  MATH,
  KINDS
};

static double *fuzz_ranges(fuzz_input *input, size_t *length) {
  *length = fuzz_count(input, MAX_RANGES) * 2;
  if (fuzz_raw(input)) { *length += fuzz_byte(input) & 1U; }
  return fuzz_numbers(input, *length);
}

static void stored_range(fuzz_input *input, uint32_t documents) {
  narsil_stored_values values = fuzz_stored_values(input, documents);
  size_t matched_words = 0;
  uint32_t *matched = fuzz_bits(input, documents, &matched_words);
  size_t range_length = 0;
  double *ranges = fuzz_ranges(input, &range_length);
  size_t capacity = fuzz_count(input, MAX_RANGES + 1);
  uint32_t *counts = FUZZ_ROOM(input, uint32_t, capacity);
  if (input->exhausted_memory) { return; }
  (void)narsil_stored_range_facet(&values, matched, matched_words, ranges, range_length, counts, capacity);
}

static void value_facet(narsil_workspace *workspace, fuzz_input *input, uint32_t documents) {
  narsil_stored_values values = fuzz_stored_values(input, documents);
  size_t matched_words = 0;
  uint32_t *matched = fuzz_bits(input, documents, &matched_words);
  size_t value_capacity = fuzz_count(input, MAX_OUTPUT);
  size_t count_capacity = fuzz_count(input, MAX_OUTPUT);
  narsil_value_facet_output output = {FUZZ_ROOM(input, uint32_t, value_capacity), value_capacity,
                                      FUZZ_ROOM(input, uint32_t, count_capacity), count_capacity};
  uint32_t *count = FUZZ_ROOM(input, uint32_t, 1);
  if (input->exhausted_memory) { return; }
  (void)narsil_value_facet(workspace, &values, matched, matched_words, &output, count);
}

static void shape_ordinals(uint32_t *ordinals, fuzz_span documents) {
  for (size_t at = 0; at < documents.count; at++) { ordinals[at] %= documents.limit + 1; }
}

static void enum_facet(narsil_workspace *workspace, fuzz_input *input, uint32_t documents) {
  size_t offset_count = fuzz_count(input, MAX_ENUM_VALUES + 1);
  size_t posting_count = fuzz_count(input, MAX_POSTINGS);
  uint32_t *offsets = FUZZ_ARRAY(input, uint32_t, offset_count);
  uint32_t *postings = FUZZ_ARRAY(input, uint32_t, posting_count);
  size_t matched_words = 0;
  uint32_t *matched = fuzz_bits(input, documents, &matched_words);
  size_t capacity = fuzz_count(input, MAX_ENUM_VALUES + 1);
  uint32_t *counts = FUZZ_ROOM(input, uint32_t, capacity);
  if (input->exhausted_memory) { return; }
  if (!fuzz_raw(input)) {
    if (offset_count > 0) {
      fuzz_ascend(offsets, (fuzz_span){offset_count, (uint32_t)posting_count});
      offsets[0] = 0;
    }
    shape_ordinals(postings, (fuzz_span){posting_count, documents});
  }
  (void)narsil_enum_facet(workspace, offsets, offset_count, postings, posting_count, matched, matched_words, counts,
                          capacity);
}

static void ascend(double *values, size_t count) {
  for (size_t at = 1; at < count; at++) {
    if (values[at] < values[at - 1]) { values[at] = values[at - 1]; }
  }
}

static narsil_numeric_facet_input fuzz_numeric(fuzz_input *input, uint32_t documents) {
  size_t count = fuzz_count(input, MAX_POSTINGS);
  size_t ordinal_count = fuzz_raw(input) ? fuzz_count(input, MAX_POSTINGS) : count;
  double *values = fuzz_numbers(input, count);
  uint32_t *ordinals = FUZZ_ARRAY(input, uint32_t, ordinal_count);
  size_t matched_words = 0;
  uint32_t *matched = fuzz_bits(input, documents, &matched_words);
  if (!input->exhausted_memory && !fuzz_raw(input)) {
    ascend(values, count);
    shape_ordinals(ordinals, (fuzz_span){ordinal_count, documents});
  }
  return (narsil_numeric_facet_input){values, count, ordinals, ordinal_count, matched, matched_words};
}

static void number_facet(narsil_workspace *workspace, fuzz_input *input, uint32_t documents) {
  narsil_numeric_facet_input numeric = fuzz_numeric(input, documents);
  size_t value_capacity = fuzz_count(input, MAX_OUTPUT);
  size_t count_capacity = fuzz_count(input, MAX_OUTPUT);
  narsil_number_facet_output output = {FUZZ_ROOM(input, double, value_capacity), value_capacity,
                                       FUZZ_ROOM(input, uint32_t, count_capacity), count_capacity};
  uint32_t *count = FUZZ_ROOM(input, uint32_t, 1);
  if (input->exhausted_memory) { return; }
  (void)narsil_number_facet(workspace, &numeric, &output, count);
}

static void range_facet(narsil_workspace *workspace, fuzz_input *input, uint32_t documents) {
  narsil_numeric_facet_input numeric = fuzz_numeric(input, documents);
  size_t range_length = 0;
  double *ranges = fuzz_ranges(input, &range_length);
  size_t capacity = fuzz_count(input, MAX_RANGES + 1);
  uint32_t *counts = FUZZ_ROOM(input, uint32_t, capacity);
  if (input->exhausted_memory) { return; }
  (void)narsil_range_facet(workspace, &numeric, ranges, range_length, counts, capacity);
}

static void boolean_facet(fuzz_input *input, uint32_t documents) {
  narsil_boolean_index index = {NULL, 0, NULL, 0};
  index.true_bits = fuzz_bits(input, documents, &index.true_words);
  index.false_bits = fuzz_bits(input, documents, &index.false_words);
  size_t matched_words = 0;
  uint32_t *matched = fuzz_bits(input, documents, &matched_words);
  size_t capacity = fuzz_count(input, 3);
  uint32_t *counts = FUZZ_ROOM(input, uint32_t, capacity);
  if (input->exhausted_memory) { return; }
  (void)narsil_boolean_facet(&index, matched, matched_words, counts, capacity);
}

static void group_hits(narsil_workspace *workspace, fuzz_input *input, uint32_t documents) {
  size_t value_count = fuzz_count(input, MAX_GROUP_FIELDS);
  narsil_stored_values *values = FUZZ_ROOM(input, narsil_stored_values, value_count);
  for (size_t at = 0; values != NULL && at < value_count; at++) { values[at] = fuzz_stored_values(input, documents); }
  size_t ordinal_count = fuzz_count(input, MAX_HITS);
  size_t matching = fuzz_raw(input) ? fuzz_count(input, MAX_HITS) : ordinal_count;
  uint32_t *ordinals = FUZZ_ARRAY(input, uint32_t, ordinal_count);
  double *scores = fuzz_numbers(input, matching);
  uint32_t *id_ranks = FUZZ_ARRAY(input, uint32_t, matching);
  narsil_group_request request = {values,
                                  value_count,
                                  ordinals,
                                  ordinal_count,
                                  scores,
                                  matching,
                                  id_ranks,
                                  matching,
                                  fuzz_below(input, MAX_PER_GROUP_CHOICES),
                                  fuzz_below(input, LIMIT_FLAG_CHOICES),
                                  fuzz_below(input, MAX_HITS)};
  size_t capacity = fuzz_count(input, MAX_HITS + 1);
  size_t member_capacity = fuzz_count(input, (size_t)MAX_HITS * MAX_GROUP_FIELDS);
  narsil_group_output output = {FUZZ_ROOM(input, uint32_t, capacity),
                                capacity,
                                FUZZ_ROOM(input, uint32_t, capacity + 1),
                                capacity + 1,
                                FUZZ_ROOM(input, uint32_t, capacity),
                                capacity,
                                FUZZ_ROOM(input, uint32_t, member_capacity),
                                member_capacity,
                                0};
  if (input->exhausted_memory) { return; }
  if (!fuzz_raw(input)) { shape_ordinals(ordinals, (fuzz_span){ordinal_count, documents}); }
  (void)narsil_group_hits(workspace, &request, &output);
}

static void sort_value(narsil_workspace *workspace, fuzz_input *input, uint32_t documents) {
  narsil_stored_values values = fuzz_stored_values(input, documents);
  uint32_t ordinal = fuzz_below(input, documents + 1);
  uint32_t mode = fuzz_below(input, SORT_MODES);
  size_t number_capacity = fuzz_count(input, 2);
  size_t text_capacity = fuzz_count(input, MAX_POSTINGS);
  narsil_sort_value_output output = {FUZZ_ROOM(input, double, number_capacity), number_capacity,
                                     FUZZ_ROOM(input, uint32_t, text_capacity), text_capacity, 0};
  if (input->exhausted_memory) { return; }
  (void)narsil_sort_value(workspace, &values, ordinal, mode, &output);
}

static void math(fuzz_input *input) {
  narsil_math_function function = (narsil_math_function)fuzz_below(input, MATH_FUNCTIONS);
  size_t count = fuzz_count(input, MAX_MATH_VALUES);
  narsil_math_batch batch = {fuzz_numbers(input, count), fuzz_numbers(input, count), FUZZ_ROOM(input, double, count),
                             count};
  if (input->exhausted_memory) { return; }
  (void)narsil_math_apply(function, &batch);
}

static void apply(narsil_workspace *workspace, uint32_t operation, fuzz_input *input, uint32_t documents) {
  switch (operation) {
    case STORED_RANGE:
      stored_range(input, documents);
      break;
    case VALUE_FACET:
      value_facet(workspace, input, documents);
      break;
    case ENUM_FACET:
      enum_facet(workspace, input, documents);
      break;
    case NUMBER_FACET:
      number_facet(workspace, input, documents);
      break;
    case RANGE_FACET:
      range_facet(workspace, input, documents);
      break;
    case BOOLEAN_FACET:
      boolean_facet(input, documents);
      break;
    case GROUP:
      group_hits(workspace, input, documents);
      break;
    case SORT_VALUE:
      sort_value(workspace, input, documents);
      break;
    default:
      math(input);
      break;
  }
}

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
  narsil_workspace *workspace = NULL;
  if (narsil_workspace_create(&workspace) != NARSIL_OK) { return 0; }
  fuzz_input input = fuzz_begin(data, size);
  uint32_t documents = fuzz_below(&input, MAX_DOCUMENTS + 1);
  uint32_t operations = 1 + fuzz_below(&input, MAX_OPERATIONS);
  for (uint32_t at = 0; at < operations && !input.exhausted_memory; at++) {
    uint32_t operation = fuzz_below(&input, KINDS);
    apply(workspace, operation, &input, documents);
  }
  narsil_workspace_destroy(workspace);
  fuzz_release(&input);
  return 0;
}
