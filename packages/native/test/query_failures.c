#include "allocation_failures.h"

#include "../include/narsil_core.h"
#include "../include/narsil_facets.h"
#include "../include/narsil_filters.h"
#include "../include/narsil_group_merge.h"
#include "../include/narsil_keyword.h"

#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define FACET_ENTRIES 8
#define FACET_BOUNDS 12
#define FACET_SPARSE_ORDINAL 33
#define FACET_FIRST_WORD 5
#define MERGE_SOURCES 6
#define MERGE_ENTRIES 7
#define MERGE_GROUPS 4
#define MERGE_ZERO_KEY 7
#define MERGE_NAN_KEY 9
#define MERGE_EMPTY_START 5
#define MERGE_NAN_RANK 5
#define MERGE_MAX_PER_GROUP 3
#define DOCUMENTS 64
#define DOCUMENT_WORDS (DOCUMENTS / 32)
#define TERM_ROWS 16
#define GROUP_ROWS 8
#define POOL_ROWS ((2 * TERM_ROWS) + GROUP_ROWS)
#define SECOND_TERM_FIRST_DOCUMENT 8
#define GROUP_FIRST_DOCUMENT 4
#define FREQUENCY_CYCLE 3
#define KEYWORD_SLOTS 3
#define KEYWORD_TERMS 3.0
#define KEYWORD_REQUIRED_TERMS 2.0
#define KEYWORD_LIMIT 5.0
#define BM25_K1 1.2
#define BM25_B 0.75
#define FILTER_VALUES 8
#define FILTER_THRESHOLD 2.0
#define FILTER_ORDINAL_STEP 7
#define GEO_LATITUDE_STEP 0.5
#define GEO_LONGITUDE_STEP 0.25
#define GEO_CODE_STEP 977
#define POLYGON_CORNERS 4
#define POLYGON_NUMBERS (1 + (2 * POLYGON_CORNERS))
#define FILTER_INSTRUCTIONS 3
#define INSTRUCTION_WORDS 4
#define NUMERIC_REGIONS 3
#define GEO_REGIONS 5

typedef struct {
  double values[FACET_ENTRIES];
  uint32_t ordinals[FACET_ENTRIES];
  uint32_t matched[2];
  double buckets[FACET_ENTRIES];
  uint32_t counts[FACET_ENTRIES];
  uint32_t range_counts[FACET_ENTRIES];
  uint32_t count;
} facet_inputs;

static void *prepare_facets(void) {
  facet_inputs *inputs = calloc(1, sizeof *inputs);
  if (inputs == NULL) { return NULL; }
  const double values[FACET_ENTRIES] = {-2, -0.0, 0, 0, 3, 3, 3, 4};
  const uint32_t ordinals[FACET_ENTRIES] = {
      0, FACET_SPARSE_ORDINAL, FACET_SPARSE_ORDINAL, 2, 2, FACET_SPARSE_ORDINAL, 2, UINT32_MAX};
  memcpy(inputs->values, values, sizeof values);
  memcpy(inputs->ordinals, ordinals, sizeof ordinals);
  inputs->matched[0] = FACET_FIRST_WORD;
  inputs->matched[1] = 2;
  return inputs;
}

static narsil_status count_facets(narsil_workspace *workspace, void *opaque) {
  facet_inputs *inputs = opaque;
  static const double ranges[FACET_BOUNDS] = {-2, 3, 0, 4, 3, 3, 4, -2, NAN, 4, -HUGE_VAL, HUGE_VAL};
  narsil_numeric_facet_input input = {inputs->values, FACET_ENTRIES,   inputs->ordinals,
                                      FACET_ENTRIES,  inputs->matched, 2};
  narsil_number_facet_output output = {inputs->buckets, FACET_ENTRIES, inputs->counts, FACET_ENTRIES};
  narsil_status status = narsil_number_facet(workspace, &input, &output, &inputs->count);
  if (status != NARSIL_OK) { return status; }
  return narsil_range_facet(workspace, &input, ranges, FACET_BOUNDS, inputs->range_counts, FACET_ENTRIES);
}

static uint64_t digest_facets(const void *opaque) { return digest_bytes(DIGEST_START, opaque, sizeof(facet_inputs)); }

typedef struct {
  uint32_t keys[MERGE_SOURCES];
  uint32_t offsets[MERGE_SOURCES + 1];
  double scores[MERGE_ENTRIES];
  uint32_t ranks[MERGE_ENTRIES];
  uint32_t out_keys[MERGE_GROUPS];
  uint32_t out_offsets[MERGE_GROUPS + 1];
  uint32_t out_sources[MERGE_ENTRIES];
  uint32_t out_indices[MERGE_ENTRIES];
  uint32_t count;
} merge_inputs;

static void *prepare_group_merge(void) {
  merge_inputs *inputs = calloc(1, sizeof *inputs);
  if (inputs == NULL) { return NULL; }
  const uint32_t keys[MERGE_SOURCES] = {UINT32_MAX, MERGE_ZERO_KEY, UINT32_MAX, 0, MERGE_NAN_KEY, MERGE_ZERO_KEY};
  const uint32_t offsets[MERGE_SOURCES + 1] = {
      0, 2, 3, MERGE_EMPTY_START, MERGE_EMPTY_START, MERGE_ENTRIES - 1, MERGE_ENTRIES};
  const double scores[MERGE_ENTRIES] = {HUGE_VAL, NAN, 0, HUGE_VAL, -HUGE_VAL, NAN, -0.0};
  const uint32_t ranks[MERGE_ENTRIES] = {2, 4, 1, 2, 3, MERGE_NAN_RANK, 1};
  memcpy(inputs->keys, keys, sizeof keys);
  memcpy(inputs->offsets, offsets, sizeof offsets);
  memcpy(inputs->scores, scores, sizeof scores);
  memcpy(inputs->ranks, ranks, sizeof ranks);
  return inputs;
}

static narsil_status merge_groups(narsil_workspace *workspace, void *opaque) {
  merge_inputs *inputs = opaque;
  narsil_group_merge_request request = {inputs->keys,
                                        MERGE_SOURCES,
                                        inputs->offsets,
                                        MERGE_SOURCES + 1,
                                        inputs->scores,
                                        MERGE_ENTRIES,
                                        NULL,
                                        0,
                                        inputs->ranks,
                                        MERGE_ENTRIES,
                                        inputs->ranks,
                                        MERGE_ENTRIES,
                                        1,
                                        0,
                                        0,
                                        MERGE_MAX_PER_GROUP,
                                        0,
                                        0};
  narsil_group_merge_output output = {inputs->out_keys,    MERGE_GROUPS,        inputs->out_offsets,
                                      MERGE_GROUPS + 1,    inputs->out_sources, MERGE_ENTRIES,
                                      inputs->out_indices, MERGE_ENTRIES,       0};
  narsil_status status = narsil_merge_groups(workspace, &request, &output);
  inputs->count = output.count;
  return status;
}

static uint64_t digest_group_merge(const void *opaque) {
  return digest_bytes(DIGEST_START, opaque, sizeof(merge_inputs));
}

typedef struct {
  uint32_t doc_ids[POOL_ROWS];
  uint16_t frequencies[POOL_ROWS];
  uint16_t fields[POOL_ROWS];
  uint32_t live[DOCUMENT_WORDS];
  int32_t ordinals[DOCUMENTS];
  double scores[DOCUMENTS];
  uint32_t matched[DOCUMENT_WORDS];
  uint32_t count;
  uint32_t total_matched;
  uint32_t scoring_path;
} keyword_inputs;

typedef struct {
  uint32_t from;
  uint32_t rows;
  uint32_t first_document;
} posting_rows;

static void fill_rows(keyword_inputs *inputs, posting_rows span) {
  for (uint32_t row = 0; row < span.rows; row++) {
    inputs->doc_ids[span.from + row] = span.first_document + row;
    inputs->frequencies[span.from + row] = (uint16_t)(1 + (row % FREQUENCY_CYCLE));
  }
}

static void *prepare_keyword(void) {
  keyword_inputs *inputs = calloc(1, sizeof *inputs);
  if (inputs == NULL) { return NULL; }
  fill_rows(inputs, (posting_rows){0, TERM_ROWS, 0});
  fill_rows(inputs, (posting_rows){TERM_ROWS, TERM_ROWS, SECOND_TERM_FIRST_DOCUMENT});
  fill_rows(inputs, (posting_rows){2 * TERM_ROWS, GROUP_ROWS, GROUP_FIRST_DOCUMENT});
  memset(inputs->live, UINT8_MAX, sizeof inputs->live);
  return inputs;
}

static narsil_status score_keywords(narsil_workspace *workspace, void *opaque) {
  keyword_inputs *inputs = opaque;
  static const uint32_t slots[KEYWORD_SLOTS * NARSIL_KEYWORD_SLOT_STRIDE] = {
      NARSIL_KEYWORD_TERM_SLOT, 0, 1, 0, NARSIL_KEYWORD_TERM_SLOT, 1, 2, 0, NARSIL_KEYWORD_GROUP_SLOT, 2, 3, 1};
  static const uint32_t lists[KEYWORD_SLOTS * NARSIL_KEYWORD_LIST_STRIDE] = {NARSIL_KEYWORD_LIST_ORDERED,
                                                                             0,
                                                                             TERM_ROWS,
                                                                             NARSIL_KEYWORD_LIST_ORDERED,
                                                                             TERM_ROWS,
                                                                             TERM_ROWS,
                                                                             NARSIL_KEYWORD_LIST_ORDERED,
                                                                             2 * TERM_ROWS,
                                                                             GROUP_ROWS};
  static const double list_values[KEYWORD_SLOTS * NARSIL_KEYWORD_LIST_VALUE_STRIDE] = {TERM_ROWS, 0,          TERM_ROWS,
                                                                                       0,         GROUP_ROWS, 0};
  static const double slot_values[] = {1};
  static const uint8_t searchable[] = {1};
  static const uint8_t partial[] = {0};
  static const uint16_t ranks[] = {0};
  static const double numbers[NARSIL_KEYWORD_FIELD_NUMBER_COLUMNS] = {1, 1, BM25_K1, BM25_B};
  static const narsil_keyword_column lengths[] = {{NULL, 0}};
  narsil_keyword_request request = {0};
  request.pool_doc_ids = inputs->doc_ids;
  request.pool_frequencies = inputs->frequencies;
  request.pool_fields = inputs->fields;
  request.pool_length = POOL_ROWS;
  request.slots = slots;
  request.slot_count = KEYWORD_SLOTS;
  request.slot_capacity = KEYWORD_SLOTS;
  request.lists = lists;
  request.list_values = list_values;
  request.list_capacity = KEYWORD_SLOTS;
  request.slot_values = slot_values;
  request.slot_value_capacity = 1;
  request.field_count = 1;
  request.searchable = searchable;
  request.partial_marks = partial;
  request.name_ranks = ranks;
  request.field_numbers = numbers;
  request.lengths = lengths;
  request.live = inputs->live;
  request.live_words = DOCUMENT_WORDS;
  request.terms = KEYWORD_TERMS;
  request.capacity = DOCUMENTS;
  request.total_documents = DOCUMENTS;
  request.term_match = KEYWORD_REQUIRED_TERMS;
  request.limit = KEYWORD_LIMIT;
  request.collect = 1;
  narsil_keyword_output output = {
      inputs->ordinals, inputs->scores, DOCUMENTS, inputs->matched, DOCUMENT_WORDS, 0, 0, 0};
  narsil_status status = narsil_keyword_score(workspace, &request, &output);
  inputs->count = output.count;
  inputs->total_matched = output.total_matched;
  inputs->scoring_path = output.scoring_path;
  return status;
}

static uint64_t digest_keyword(const void *opaque) {
  const keyword_inputs *inputs = opaque;
  uint64_t digest = digest_bytes(DIGEST_START, inputs->matched, sizeof inputs->matched);
  digest = digest_word(digest, inputs->count);
  digest = digest_word(digest, inputs->total_matched);
  digest = digest_word(digest, inputs->scoring_path);
  digest = digest_bytes(digest, inputs->ordinals, inputs->count * sizeof inputs->ordinals[0]);
  return digest_bytes(digest, inputs->scores, inputs->count * sizeof inputs->scores[0]);
}

typedef struct {
  uint32_t live[DOCUMENT_WORDS];
  uint32_t present[DOCUMENT_WORDS];
  double values[FILTER_VALUES];
  uint32_t ordinals[FILTER_VALUES];
  uint64_t codes[FILTER_VALUES];
  double latitudes[FILTER_VALUES];
  double longitudes[FILTER_VALUES];
  uint32_t into[DOCUMENT_WORDS];
} filter_inputs;

static void *prepare_filter(void) {
  filter_inputs *inputs = calloc(1, sizeof *inputs);
  if (inputs == NULL) { return NULL; }
  memset(inputs->live, UINT8_MAX, sizeof inputs->live);
  memset(inputs->present, UINT8_MAX, sizeof inputs->present);
  for (uint32_t at = 0; at < FILTER_VALUES; at++) {
    inputs->values[at] = at;
    inputs->ordinals[at] = (at * FILTER_ORDINAL_STEP) % DOCUMENTS;
    inputs->codes[at] = (uint64_t)at * GEO_CODE_STEP;
    inputs->latitudes[at] = at * GEO_LATITUDE_STEP;
    inputs->longitudes[at] = at * GEO_LONGITUDE_STEP;
  }
  return inputs;
}

static narsil_status evaluate_filter(narsil_workspace *workspace, void *opaque) {
  filter_inputs *inputs = opaque;
  static const uint32_t plan[FILTER_INSTRUCTIONS * INSTRUCTION_WORDS] = {NARSIL_FILTER_TEST,
                                                                         0,
                                                                         NARSIL_FILTER_GTE,
                                                                         0,
                                                                         NARSIL_FILTER_TEST,
                                                                         1,
                                                                         NARSIL_FILTER_POLYGON,
                                                                         1,
                                                                         NARSIL_FILTER_OR,
                                                                         0,
                                                                         0,
                                                                         2};
  static const double numbers[1 + POLYGON_NUMBERS] = {FILTER_THRESHOLD, POLYGON_CORNERS, -1, -1, -1, 3, 3, 3, 3, -1};
  static const uint32_t offsets[] = {0};
  narsil_filter_field fields[2] = {
      {NARSIL_FILTER_NUMERIC,
       NUMERIC_REGIONS,
       {{inputs->present, DOCUMENT_WORDS}, {inputs->values, FILTER_VALUES}, {inputs->ordinals, FILTER_VALUES}}},
      {NARSIL_FILTER_GEO,
       GEO_REGIONS,
       {{inputs->present, DOCUMENT_WORDS},
        {inputs->codes, FILTER_VALUES},
        {inputs->latitudes, FILTER_VALUES},
        {inputs->longitudes, FILTER_VALUES},
        {inputs->ordinals, FILTER_VALUES}}},
  };
  narsil_filter_program program = {plan,
                                   sizeof plan / sizeof plan[0],
                                   numbers,
                                   sizeof numbers / sizeof numbers[0],
                                   NULL,
                                   0,
                                   offsets,
                                   1,
                                   NULL,
                                   0,
                                   NULL,
                                   0,
                                   fields,
                                   2,
                                   {inputs->live, DOCUMENT_WORDS}};
  return narsil_evaluate_filter(workspace, &program, inputs->into, DOCUMENT_WORDS);
}

static uint64_t digest_filter(const void *opaque) { return digest_bytes(DIGEST_START, opaque, sizeof(filter_inputs)); }

void query_allocation_failures(void) {
  const failing_call calls[] = {
      {"numeric and range facets", prepare_facets, count_facets, digest_facets, free},
      {"a group merge", prepare_group_merge, merge_groups, digest_group_merge, free},
      {"a keyword score with groups and a limit", prepare_keyword, score_keywords, digest_keyword, free},
      {"a numeric and polygon filter", prepare_filter, evaluate_filter, digest_filter, free},
  };
  for (size_t at = 0; at < sizeof calls / sizeof calls[0]; at++) { refuse_each_allocation(&calls[at]); }
  group_allocation_failures();
  sort_value_allocation_failures();
  sort_order_allocation_failures();
}
