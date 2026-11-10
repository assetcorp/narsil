#include "allocation_failures.h"
#include "fixture.h"

#include "../include/narsil_analysis.h"
#include "../include/narsil_core.h"
#include "../include/narsil_facet_merge.h"
#include "../include/narsil_fusion.h"
#include "../include/narsil_group_merge.h"
#include "../include/narsil_keyword.h"
#include "../include/narsil_merges.h"
#include "../include/narsil_packed_tokens.h"
#include "../include/narsil_pages.h"
#include "../include/narsil_pinned.h"
#include "../include/narsil_terms.h"
#include "../src/keyword/regions.h"

#include <float.h>
#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#define ANALYSIS_THREADS_ONLY "analysis-threads"
#define METRIC_COUNT 3
#define UNKNOWN_METRIC 9
#define SEARCH_THREAD_SLOT 1

#define CORRUPT_HUGE_COUNT (1 << 30)
#define CORRUPT_NEGATIVE_COUNT (-5)
#define CORRUPT_ORDINAL_PAST_THE_GRAPH (NODES + 1000)
#define CORRUPT_NEGATIVE_ORDINAL (-7)
#define CORRUPT_UPPER_BASE (1 << 28)
#define CORRUPT_NEGATIVE_UPPER_BASE (-3)
#define CORRUPTED_NODE_STEP 3
#define CORRUPT_UPPER_NODE 16
#define TOMBSTONED_ORDINAL 7
#define UNRECORDED_ORDINAL 14
#define RESCORED_ORDINAL 3
#define RESCORED_ORDINAL_PAST_THE_STORE (NODES + 5)
#define LISTS_LONGER_THAN_THE_WORKSPACE (1 << 20)
#define PAGE_COUNT_NEEDING_TWO_WORDS 33
#define FUSION_RANK_CONSTANT 60
#define MERGE_ENTRIES 9
#define MERGE_SHORT_ENTRIES 8
#define MERGE_OFFSET_COUNT 6
#define MERGE_LAST_RANK 6

static void check_sorted(const narsil_candidates *found, const char *what) {
  for (uint32_t i = 1; i < found->count; i++) { check(found->distances[i - 1] <= found->distances[i], what); }
  for (uint32_t i = 0; i < found->count; i++) {
    check(found->ordinals[i] >= 0 && found->ordinals[i] < NODES, "every result ordinal is inside the graph");
  }
}

static void search_one_width(narsil_workspace *workspace, uint32_t bits, const float *query) {
  test_fixture *fixture = build_fixture(bits);
  check(fixture != NULL, "the fixture has its memory");
  if (fixture == NULL) { return; }
  int32_t ordinals[CANDIDATES];
  double distances[CANDIDATES];
  for (uint32_t metric = 0; metric < METRIC_COUNT; metric++) {
    narsil_candidates found = {ordinals, distances, CANDIDATES, 0};
    narsil_search_request request = {query, metric, CANDIDATES, SEARCH_THREAD_SLOT, {NULL, 0}, FIXTURE_PIN};
    check(narsil_search(workspace, &fixture->graph, &fixture->store, &request, &found) == NARSIL_OK,
          "search returns NARSIL_OK");
    check(found.count == CANDIDATES, "search fills the candidate count");
    check_sorted(&found, "search returns the nearest first");
    check(fixture->graph_header[NARSIL_GRAPH_WORD_LOCK] == 0, "the graph lock word is 0 after a search");
    check(fixture->held_locks[(SEARCH_THREAD_SLOT * NARSIL_HELD_WORDS_PER_THREAD) + NARSIL_HELD_WORD_GRAPH] == 0,
          "the held-lock record is 0 after a search");

    double scored[CANDIDATES];
    narsil_score_request scoring = {query, metric, ordinals, found.count, FIXTURE_PIN};
    check(narsil_score(workspace, &fixture->store, &scoring, scored) == NARSIL_OK, "score returns NARSIL_OK");
    for (uint32_t i = 0; i < found.count; i++) {
      check(isfinite(scored[i]), "score gives a finite distance for a stored vector");
    }
  }
  release_fixture(fixture);
}

static void search_every_width(narsil_workspace *workspace) {
  const uint32_t widths[] = {0, 1, 2, 4, BITS_PER_BYTE};
  float query[DIMENSION];
  for (int i = 0; i < DIMENSION; i++) { query[i] = (random_unit() * 2) - 1; }
  for (size_t width = 0; width < sizeof widths / sizeof widths[0]; width++) {
    search_one_width(workspace, widths[width], query);
  }
}

static void corrupt_lists(test_fixture *fixture) {
  for (int32_t node = 0; node < NODES; node += CORRUPTED_NODE_STEP) {
    int32_t *list = fixture->level0 + ((size_t)node * (MAX_BASE_NEIGHBOURS + NARSIL_LIST_WORDS_OVER_NEIGHBOURS));
    list[0] = node % 2 == 0 ? CORRUPT_HUGE_COUNT : CORRUPT_NEGATIVE_COUNT;
    list[1] = CORRUPT_ORDINAL_PAST_THE_GRAPH;
    list[2] = CORRUPT_NEGATIVE_ORDINAL;
    list[3] = INT32_MAX;
  }
  fixture->upper_base[0] = CORRUPT_UPPER_BASE;
  fixture->upper_base[CORRUPT_UPPER_NODE] = CORRUPT_NEGATIVE_UPPER_BASE;
  fixture->tombstones[TOMBSTONED_ORDINAL] = 1;
  fixture->code_present[UNRECORDED_ORDINAL] = 0;
}

static void survive_corrupt_lists(narsil_workspace *workspace) {
  test_fixture *fixture = build_fixture(4);
  check(fixture != NULL, "the fixture has its memory");
  if (fixture == NULL) { return; }
  corrupt_lists(fixture);

  int32_t ordinals[CANDIDATES];
  double distances[CANDIDATES];
  float query[DIMENSION];
  for (int i = 0; i < DIMENSION; i++) { query[i] = random_unit(); }
  narsil_candidates found = {ordinals, distances, CANDIDATES, 0};
  narsil_search_request request = {query, NARSIL_METRIC_COSINE, CANDIDATES, 0, {NULL, 0}, FIXTURE_PIN};
  check(narsil_search(workspace, &fixture->graph, &fixture->store, &request, &found) == NARSIL_OK,
        "search returns NARSIL_OK over corrupt lists");
  check_sorted(&found, "search over corrupt lists returns ordinals inside the graph");
  for (uint32_t i = 0; i < found.count; i++) {
    check(found.ordinals[i] != TOMBSTONED_ORDINAL, "search skips a tombstone");
    check(found.ordinals[i] != UNRECORDED_ORDINAL, "search skips an ordinal with no record");
  }

  int32_t unsorted[3] = {-1, RESCORED_ORDINAL_PAST_THE_STORE, RESCORED_ORDINAL};
  double scored[3];
  narsil_score_request scoring = {query, NARSIL_METRIC_EUCLIDEAN, unsorted, 3, FIXTURE_PIN};
  check(narsil_score(workspace, &fixture->store, &scoring, scored) == NARSIL_OK,
        "score returns NARSIL_OK over ordinals outside the store");
  check(isinf(scored[0]) && isinf(scored[1]) && isfinite(scored[2]),
        "score gives infinity for an ordinal outside the store");
  release_fixture(fixture);
}

static void refuse_bad_arguments(narsil_workspace *workspace) {
  test_fixture *fixture = build_fixture(4);
  check(fixture != NULL, "the fixture has its memory");
  if (fixture == NULL) { return; }
  int32_t ordinals[CANDIDATES] = {0};
  double distances[CANDIDATES] = {0};
  float query[DIMENSION] = {0};
  narsil_candidates found = {ordinals, distances, 4, 0};
  narsil_search_request request = {query, NARSIL_METRIC_COSINE, CANDIDATES, 0, {NULL, 0}, FIXTURE_PIN};
  check(narsil_search(workspace, &fixture->graph, &fixture->store, &request, &found) == NARSIL_INVALID_ARGUMENT,
        "search returns NARSIL_INVALID_ARGUMENT for a short result list");
  check(fixture->graph_header[NARSIL_GRAPH_WORD_LOCK] == 0, "the graph lock word is 0 after a refused search");
  found.capacity = CANDIDATES;
  request.thread_slot = THREAD_SLOTS;
  check(narsil_search(workspace, &fixture->graph, &fixture->store, &request, &found) == NARSIL_INVALID_ARGUMENT,
        "search returns NARSIL_INVALID_ARGUMENT for a thread slot outside heldLocks");
  request.thread_slot = 0;
  request.metric = UNKNOWN_METRIC;
  check(narsil_search(workspace, &fixture->graph, &fixture->store, &request, &found) == NARSIL_INVALID_ARGUMENT,
        "search returns NARSIL_INVALID_ARGUMENT for an unknown metric");
  double scored[1];
  narsil_score_request scoring = {query, UNKNOWN_METRIC, ordinals, 1, FIXTURE_PIN};
  check(narsil_score(workspace, &fixture->store, &scoring, scored) == NARSIL_INVALID_ARGUMENT,
        "score returns NARSIL_INVALID_ARGUMENT for an unknown metric");
  check(narsil_search(workspace, &fixture->graph, &fixture->store, NULL, &found) == NARSIL_INVALID_ARGUMENT,
        "search returns NARSIL_INVALID_ARGUMENT for a missing request");
  request.metric = NARSIL_METRIC_COSINE;
  fixture->graph_header[NARSIL_GRAPH_WORD_MMAX0] = LISTS_LONGER_THAN_THE_WORKSPACE;
  check(narsil_search(workspace, &fixture->graph, &fixture->store, &request, &found) == NARSIL_INVALID_ARGUMENT,
        "search returns NARSIL_INVALID_ARGUMENT for lists longer than the workspace holds");
  fixture->graph_header[NARSIL_GRAPH_WORD_MMAX0] = MAX_BASE_NEIGHBOURS;
  release_fixture(fixture);
}

static void page_boundaries(void) {
  uint32_t after[] = {UINT32_MAX, UINT32_MAX};
  uint32_t present[] = {1, 0};
  double scores[] = {0, NAN};
  uint32_t start = UINT32_MAX;
  narsil_page_request request = {2, 0, 1, 1, scores, 2, present, 1, after, 1, 0};
  check(narsil_page_start(&request, &start) == NARSIL_OK && start == 0,
        "a present zero score ties the anchor and follows its ID");
  request.score_present = NULL;
  request.score_present_length = 0;
  scores[1] = -0.0;
  after[0] = UINT32_MAX << 2;
  check(narsil_page_start(&request, &start) == NARSIL_OK && start == request.count,
        "bitmap padding cannot place a page beyond its logical count");
  request.count = PAGE_COUNT_NEEDING_TWO_WORDS;
  request.has_scores = 0;
  request.scores = NULL;
  request.scores_length = 0;
  start = UINT32_MAX;
  check(narsil_page_start(&request, &start) == NARSIL_INVALID_ARGUMENT && start == UINT32_MAX,
        "a short anchor region is refused without changing the output");
  request.after_anchor_length = 2;
  request.score_present = present;
  request.score_present_length = 2;
  check(narsil_page_start(&request, &start) == NARSIL_INVALID_ARGUMENT && start == UINT32_MAX,
        "a presence bitmap without scores is refused without changing the output");
  request.count = 2;
  request.has_scores = 1;
  request.scores = scores;
  request.scores_length = 1;
  check(narsil_page_start(&request, &start) == NARSIL_INVALID_ARGUMENT && start == UINT32_MAX,
        "a short score region is refused before paging reads scores");
  request.scores_length = 2;
  request.score_present_length = 0;
  check(narsil_page_start(&request, &start) == NARSIL_INVALID_ARGUMENT && start == UINT32_MAX,
        "a short score validity region is refused before any output changes");
  request.score_present_length = 1;
  uint32_t saved_after = after[0];
  check(narsil_page_start(&request, after) == NARSIL_INVALID_ARGUMENT && after[0] == saved_after,
        "a page position cannot overwrite its anchor bitmap");
}

static int same_score_bits(const double *left, size_t count, const double *right) {
  for (size_t position = 0; position < count; position++) {
    uint64_t left_bits = 0;
    uint64_t right_bits = 0;
    memcpy(&left_bits, left + position, sizeof left_bits);
    memcpy(&right_bits, right + position, sizeof right_bits);
    if (left_bits != right_bits) { return 0; }
  }
  return 1;
}

static void fusion_boundaries(narsil_workspace *workspace) {
  uint32_t keys[] = {0, 1, 2, 3};
  uint32_t ranks[] = {0, 1, 2, 3};
  double scores[] = {INFINITY, 0, -(double)INFINITY, NAN};
  uint32_t result_keys[4] = {0};
  double result_scores[4] = {0};
  narsil_fusion_output output = {result_keys, result_scores, 4, 0};
  narsil_fusion_request request = {
      NARSIL_FUSION_LINEAR, FUSION_RANK_CONSTANT, 0, {keys, scores, 4}, {NULL, NULL, 0}, ranks, 4};
  check(narsil_fuse(workspace, &request, &output) == NARSIL_OK && output.count == 4 && result_keys[0] == 0 &&
            result_scores[0] == 1 && result_scores[1] == 1.0 / 2,
        "fusion returns finite scores for non-finite inputs");
  request.alpha = 0;
  output.count = UINT32_MAX;
  output.capacity = 3;
  uint32_t saved_keys[4];
  double saved_scores[4];
  memcpy(saved_keys, result_keys, sizeof saved_keys);
  memcpy(saved_scores, result_scores, sizeof saved_scores);
  check(narsil_fuse(workspace, &request, &output) == NARSIL_NEEDS_ROOM && output.count == UINT32_MAX &&
            memcmp(saved_keys, result_keys, sizeof saved_keys) == 0 && same_score_bits(saved_scores, 4, result_scores),
        "short fusion outputs remain unchanged");
  output.capacity = 4;
  keys[1] = 0;
  check(narsil_fuse(workspace, &request, &output) == NARSIL_INVALID_ARGUMENT && output.count == UINT32_MAX &&
            memcmp(saved_keys, result_keys, sizeof saved_keys) == 0 && same_score_bits(saved_scores, 4, result_scores),
        "duplicate fusion keys are refused before outputs change");
  keys[1] = 1;
  output.keys = keys;
  check(narsil_fuse(workspace, &request, &output) == NARSIL_INVALID_ARGUMENT && output.count == UINT32_MAX,
        "fusion refuses an output that overwrites input keys");
  output.keys = &output.count;
  output.capacity = 1;
  check(narsil_fuse(workspace, &request, &output) == NARSIL_INVALID_ARGUMENT && output.count == UINT32_MAX,
        "fusion output cannot overwrite its count");
}

static void merge_boundaries(narsil_workspace *workspace) {
  uint32_t offsets[] = {0, 0, 4, 4, MERGE_SHORT_ENTRIES, MERGE_ENTRIES};
  double scores[] = {INFINITY, 0, -(double)INFINITY, NAN, INFINITY, -0.0, -(double)INFINITY, NAN, NAN};
  uint32_t ranks[] = {2, 2, 2, 2, 1, 2, 1, 1, 1};
  uint32_t lists[MERGE_ENTRIES] = {0};
  uint32_t indices[MERGE_ENTRIES] = {0};
  const uint32_t expected_lists[] = {3, 1, 1, 3, 3, 1, 3, 4, 1};
  const uint32_t expected_indices[] = {0, 0, 1, 1, 2, 2, 3, 0, 3};
  narsil_merge_request request = {offsets, MERGE_OFFSET_COUNT, scores,       MERGE_ENTRIES,
                                  ranks,   MERGE_ENTRIES,      MERGE_ENTRIES};
  narsil_merge_output output = {lists, MERGE_ENTRIES, indices, MERGE_ENTRIES, 0};
  check(narsil_merge_rankings(workspace, &request, &output) == NARSIL_OK && output.count == MERGE_ENTRIES &&
            memcmp(lists, expected_lists, sizeof lists) == 0 && memcmp(indices, expected_indices, sizeof indices) == 0,
        "ranked merges preserve source positions and score ties");
  output.count = UINT32_MAX;
  output.index_capacity = MERGE_SHORT_ENTRIES;
  check(narsil_merge_rankings(workspace, &request, &output) == NARSIL_NEEDS_ROOM && output.count == UINT32_MAX &&
            memcmp(lists, expected_lists, sizeof lists) == 0 && memcmp(indices, expected_indices, sizeof indices) == 0,
        "a short merge output preserves the previous entries and count");
  output.index_capacity = MERGE_ENTRIES;
  request.score_count = MERGE_SHORT_ENTRIES;
  check(narsil_merge_rankings(workspace, &request, &output) == NARSIL_INVALID_ARGUMENT,
        "ranked merges refuse a short score region");
  request.score_count = MERGE_ENTRIES;
  offsets[2] = 4 + 1;
  check(narsil_merge_rankings(workspace, &request, &output) == NARSIL_INVALID_ARGUMENT,
        "ranked merges refuse decreasing offsets");
  offsets[2] = 4;
  output.indices = lists + 1;
  output.index_capacity = MERGE_SHORT_ENTRIES;
  check(narsil_merge_rankings(workspace, &request, &output) == NARSIL_INVALID_ARGUMENT,
        "ranked merges refuse overlapping output views");
  output.indices = indices;
  output.index_capacity = MERGE_ENTRIES;
  output.lists = ranks;
  check(narsil_merge_rankings(workspace, &request, &output) == NARSIL_INVALID_ARGUMENT && ranks[0] == 2,
        "ranked output cannot overwrite live ranks");
  output.lists = lists;
  uint32_t sorted_ranks[] = {0, 2, 4, MERGE_LAST_RANK, 1, 2, 4, MERGE_LAST_RANK, MERGE_LAST_RANK};
  const uint32_t sorted_lists[] = {1, 3, 1, 3, 1, 3, 1, 3, 4};
  const uint32_t sorted_indices[] = {0, 0, 1, 1, 2, 2, 3, 3, 0};
  request.ranks = sorted_ranks;
  request.scores = NULL;
  request.score_count = 0;
  check(narsil_merge_sorted(workspace, &request, &output) == NARSIL_OK && output.count == MERGE_ENTRIES &&
            memcmp(lists, sorted_lists, sizeof lists) == 0 && memcmp(indices, sorted_indices, sizeof indices) == 0,
        "sorted merges retain source numbering and stable ranks");
}

static void keyword_region_boundaries(narsil_workspace *workspace) {
  enum { SETTING_COUNT = 9, OUTCOME_COUNT = 3 };
  uint32_t doc_ids[] = {1};
  uint16_t frequencies[] = {1};
  uint16_t fields[] = {0};
  uint32_t slots[] = {NARSIL_KEYWORD_TERM_SLOT, 0, 1, 0};
  uint32_t lists[] = {NARSIL_KEYWORD_LIST_ORDERED, 0, 1};
  double list_values[] = {1, 0};
  uint8_t searchable[] = {1};
  uint8_t partial[] = {0};
  uint16_t ranks[] = {0};
  double numbers[] = {1, 1, 1, 0};
  narsil_keyword_column lengths[] = {{NULL, 0}};
  uint32_t live[] = {1U << 1};
  uint32_t matched[] = {0};
  int32_t ordinals[4] = {0};
  double scores[4] = {0};
  narsil_keyword_request request = {0};
  request.pool_doc_ids = doc_ids;
  request.pool_frequencies = frequencies;
  request.pool_fields = fields;
  request.pool_length = 1;
  request.slots = slots;
  request.slot_count = 1;
  request.slot_capacity = 1;
  request.lists = lists;
  request.list_values = list_values;
  request.list_capacity = 1;
  request.field_count = 1;
  request.searchable = searchable;
  request.partial_marks = partial;
  request.name_ranks = ranks;
  request.field_numbers = numbers;
  request.lengths = lengths;
  request.live = live;
  request.live_words = 1;
  request.terms = 1;
  request.capacity = 4;
  request.total_documents = 4;
  request.limit = NARSIL_KEYWORD_NO_LIMIT;
  request.collect = 1;
  narsil_keyword_output output = {ordinals, scores, 4, matched, 1, 0, 0, 0};
  check(narsil_keyword_score(workspace, &request, &output) == NARSIL_OK && output.count == 1 && ordinals[0] == 1,
        "keyword scoring accepts separate input and output regions");
  double saved[4];
  memcpy(saved, scores, sizeof saved);
  output.count = UINT32_MAX;
  output.length = 3;
  check(narsil_keyword_score(workspace, &request, &output) == NARSIL_INVALID_ARGUMENT && output.count == UINT32_MAX &&
            same_score_bits(saved, 4, scores),
        "short keyword output preserves its score and count");
  output.length = 4;
  output.matched = &output.count;
  check(narsil_keyword_score(workspace, &request, &output) == NARSIL_INVALID_ARGUMENT && output.count == UINT32_MAX,
        "keyword output cannot overwrite its outcome");
  output.matched = live;
  check(narsil_keyword_score(workspace, &request, &output) == NARSIL_INVALID_ARGUMENT && live[0] == (1U << 1),
        "keyword output cannot overwrite live inputs");
  output.matched = matched;
  double settings[SETTING_COUNT] = {0};
  check(!keyword_binding_regions_are_disjoint(&request, &output, settings, SETTING_COUNT, scores, OUTCOME_COUNT) &&
            same_score_bits(saved, 4, scores),
        "keyword binding metadata cannot overlap scoring output");
}

static void pinned_boundaries(narsil_workspace *workspace) {
  enum { RANKED_COUNT = 5, PIN_COUNT = 4, OUTPUT_COUNT = 7, POSITION_PAST_END = 100 };
  int32_t ranked[] = {3, -1, 0, -1};
  uint32_t positions[] = {0, 0, POSITION_PAST_END, 2};
  int32_t entries[OUTPUT_COUNT];
  int32_t expected[] = {-2, -1, -4, 1, 2, 4, -3};
  narsil_pinned_request request = {RANKED_COUNT, ranked, PIN_COUNT, positions, PIN_COUNT, 0, 0};
  narsil_pinned_output output = {entries, OUTPUT_COUNT, 0};
  check(narsil_place_pinned(workspace, &request, &output) == NARSIL_OK && output.count == OUTPUT_COUNT &&
            memcmp(entries, expected, sizeof expected) == 0,
        "pins retain input order and clamp positions to the available entries");
  output.capacity = OUTPUT_COUNT - 1;
  check(narsil_place_pinned(workspace, &request, &output) == NARSIL_NEEDS_ROOM && output.count == OUTPUT_COUNT &&
            memcmp(entries, expected, sizeof expected) == 0,
        "short pin output preserves every entry and count");
  output.capacity = OUTPUT_COUNT;
  request.count = (uint32_t)INT32_MAX + 1U;
  check(narsil_place_pinned(workspace, &request, &output) == NARSIL_INVALID_ARGUMENT,
        "rank counts must fit the signed entry layout");
  request.count = RANKED_COUNT;
  request.ranked_count = (size_t)INT32_MAX + 1U;
  request.position_count = request.ranked_count;
  check(narsil_place_pinned(workspace, &request, &output) == NARSIL_INVALID_ARGUMENT,
        "pin counts must fit the signed entry layout before reading their regions");
  request.ranked_count = PIN_COUNT;
  request.position_count = PIN_COUNT - 1;
  check(narsil_place_pinned(workspace, &request, &output) == NARSIL_INVALID_ARGUMENT,
        "pin positions require one region entry per pin");
  request.position_count = PIN_COUNT;
  ranked[2] = ranked[0];
  check(narsil_place_pinned(workspace, &request, &output) == NARSIL_INVALID_ARGUMENT &&
            memcmp(entries, expected, sizeof expected) == 0,
        "duplicate ranked pins cannot partially publish");
  ranked[2] = RANKED_COUNT;
  check(narsil_place_pinned(workspace, &request, &output) == NARSIL_INVALID_ARGUMENT,
        "pin ranks cannot read outside the ranking");
  ranked[2] = 0;
  output.entries = ranked;
  output.capacity = PIN_COUNT;
  check(narsil_place_pinned(workspace, &request, &output) == NARSIL_INVALID_ARGUMENT && ranked[0] == 3,
        "pin output cannot overwrite live ranked input");
}

static void facet_merge_boundaries(narsil_workspace *workspace) {
  enum { SOURCE_COUNT = 3, ENTRY_COUNT = 5, KEY_COUNT = 3, MERGED_COUNT = 5 };
  uint32_t offsets[] = {0, 0, 3, ENTRY_COUNT};
  uint32_t keys[] = {2, 0, 1, 0, 2};
  uint32_t counts[] = {4, 3, 0, 2, 1};
  uint32_t bounds[] = {0, 2, 1};
  uint32_t ranks[] = {2, 0, 1};
  uint32_t out_keys[KEY_COUNT] = {0};
  uint32_t out_counts[KEY_COUNT] = {0};
  uint32_t bound = 0;
  narsil_facet_merge_request request = {offsets, SOURCE_COUNT + 1, keys,  ENTRY_COUNT, counts, ENTRY_COUNT,
                                        bounds,  SOURCE_COUNT,     ranks, KEY_COUNT,   0,      0,
                                        0};
  narsil_facet_merge_output output = {out_keys, KEY_COUNT, out_counts, KEY_COUNT, &bound, 1, 0};
  const uint32_t expected[] = {2, 0, 1};
  check(narsil_merge_facets(workspace, &request, &output) == NARSIL_OK && output.count == KEY_COUNT && bound == 3 &&
            memcmp(out_keys, expected, sizeof expected) == 0 && out_counts[2] == 0 && out_counts[1] == MERGED_COUNT,
        "facet merges combine repeated values and retain the error bound");
  uint32_t saved_counts[KEY_COUNT];
  memcpy(saved_counts, out_counts, sizeof out_counts);
  output.count = UINT32_MAX;
  output.count_capacity = KEY_COUNT - 1;
  check(narsil_merge_facets(workspace, &request, &output) == NARSIL_NEEDS_ROOM && output.count == UINT32_MAX &&
            bound == 3 && memcmp(out_keys, expected, sizeof expected) == 0 &&
            memcmp(saved_counts, out_counts, sizeof out_counts) == 0,
        "a short facet output preserves every region");
  output.count_capacity = KEY_COUNT;
  request.count_count = ENTRY_COUNT - 1;
  check(narsil_merge_facets(workspace, &request, &output) == NARSIL_INVALID_ARGUMENT,
        "facet merges require one count per entry");
  request.count_count = ENTRY_COUNT;
  keys[0] = KEY_COUNT;
  check(narsil_merge_facets(workspace, &request, &output) == NARSIL_INVALID_ARGUMENT,
        "facet keys cannot read beyond the rank region");
  keys[0] = 2;
  counts[1] = UINT32_MAX;
  check(narsil_merge_facets(workspace, &request, &output) == NARSIL_INVALID_ARGUMENT,
        "facet count accumulation cannot overflow");
  counts[1] = 3;
  output.values = keys;
  check(narsil_merge_facets(workspace, &request, &output) == NARSIL_INVALID_ARGUMENT,
        "facet output cannot overwrite live keys");
  output.values = out_keys;
  output.counts = out_keys;
  check(narsil_merge_facets(workspace, &request, &output) == NARSIL_INVALID_ARGUMENT,
        "facet output regions cannot overwrite each other");
}

static void group_merge_boundaries(narsil_workspace *workspace) {
  enum {
    SOURCES = 6,
    ENTRIES = 7,
    GROUPS = 4,
    KEPT_ENTRIES = 6,
    ZERO_KEY = 7,
    NAN_KEY = 9,
    EMPTY_START = 5,
    NAN_RANK = 5
  };
  uint32_t keys[SOURCES] = {UINT32_MAX, ZERO_KEY, UINT32_MAX, 0, NAN_KEY, ZERO_KEY};
  uint32_t offsets[SOURCES + 1] = {0, 2, 3, EMPTY_START, EMPTY_START, ENTRIES - 1, ENTRIES};
  double scores[ENTRIES] = {HUGE_VAL, NAN, 0, HUGE_VAL, -HUGE_VAL, NAN, -0.0};
  uint32_t ranks[ENTRIES] = {2, 4, 1, 2, 3, NAN_RANK, 1};
  uint32_t out_keys[GROUPS] = {0};
  uint32_t out_offsets[GROUPS + 1] = {0};
  uint32_t out_sources[ENTRIES] = {0};
  uint32_t out_indices[ENTRIES] = {0};
  narsil_group_merge_request request = {keys,    SOURCES, offsets, SOURCES + 1, scores, ENTRIES, NULL, 0, ranks,
                                        ENTRIES, ranks,   ENTRIES, 1,           0,      0,       3,    0, 0};
  narsil_group_merge_output output = {out_keys, GROUPS,      out_offsets, GROUPS + 1, out_sources,
                                      ENTRIES,  out_indices, ENTRIES,     0};
  uint32_t expected_keys[GROUPS] = {UINT32_MAX, 0, ZERO_KEY, NAN_KEY};
  uint32_t expected_offsets[GROUPS + 1] = {0, 3, 3, KEPT_ENTRIES - 1, KEPT_ENTRIES};
  uint32_t expected_sources[KEPT_ENTRIES] = {0, 2, 2, 1, SOURCES - 1, 4};
  uint32_t expected_indices[KEPT_ENTRIES] = {0, 0, 1, 0, 0, 0};
  check(narsil_merge_groups(workspace, &request, &output) == NARSIL_OK && output.count == GROUPS &&
            memcmp(out_keys, expected_keys, sizeof expected_keys) == 0 &&
            memcmp(out_offsets, expected_offsets, sizeof expected_offsets) == 0 &&
            memcmp(out_sources, expected_sources, sizeof expected_sources) == 0 &&
            memcmp(out_indices, expected_indices, sizeof expected_indices) == 0,
        "group merges retain source positions and sparse identities");
  output.count = UINT32_MAX;
  output.source_capacity = 2;
  check(narsil_merge_groups(workspace, &request, &output) == NARSIL_NEEDS_ROOM && output.count == UINT32_MAX &&
            memcmp(out_keys, expected_keys, sizeof expected_keys) == 0 &&
            memcmp(out_offsets, expected_offsets, sizeof expected_offsets) == 0 &&
            memcmp(out_sources, expected_sources, sizeof expected_sources) == 0 &&
            memcmp(out_indices, expected_indices, sizeof expected_indices) == 0,
        "short group output preserves every region and count");
  output.source_capacity = ENTRIES;
  output.keys = keys;
  check(narsil_merge_groups(workspace, &request, &output) == NARSIL_INVALID_ARGUMENT,
        "group output cannot overwrite input keys");
  output.keys = out_keys;
  output.indices = out_sources;
  check(narsil_merge_groups(workspace, &request, &output) == NARSIL_INVALID_ARGUMENT,
        "group outputs cannot overwrite one another");
  output.indices = out_indices;
  request.has_score_present = 1;
  check(narsil_merge_groups(workspace, &request, &output) == NARSIL_INVALID_ARGUMENT,
        "a supplied score bitmap must have enough words");
  request.has_score_present = 0;
  request.score_count = ENTRIES - 1;
  check(narsil_merge_groups(workspace, &request, &output) == NARSIL_INVALID_ARGUMENT,
        "group scores require a slot for every entry");
  request.score_count = ENTRIES;
  offsets[2] = 1;
  check(narsil_merge_groups(workspace, &request, &output) == NARSIL_INVALID_ARGUMENT, "group offsets cannot decrease");
}

static void packed_analysis_boundaries(void) {
  enum {
    RECORDS = 9,
    INPUT_UNITS = 12,
    OUTPUT_UNITS = 11,
    TERM_START = 1,
    TERM_LENGTH = 4,
    SURFACE_START = 5,
    SURFACE_LENGTH = 7,
    POSITION = 3,
    MARKER = 71
  };
  const uint16_t text[] = {'x', 'r', 'u', 'n', 's', 'r', 'u', 'n', 'n', 'i', 'n', 'g'};
  narsil_token token = {POSITION, TERM_START, TERM_LENGTH, SURFACE_START, SURFACE_LENGTH, 0, INPUT_UNITS, 0};
  narsil_tokens source = {&token, 1, text, INPUT_UNITS};
  uint32_t records[RECORDS];
  uint16_t units[OUTPUT_UNITS] = {0};
  for (size_t at = 0; at < RECORDS; at++) { records[at] = MARKER; }
  uint32_t needed = 0;
  narsil_status short_status = narsil_pack_tokens(&source, records, RECORDS, units, OUTPUT_UNITS - 1, &needed);
  int untouched = 1;
  for (size_t at = 1; at < RECORDS; at++) { untouched &= records[at] == MARKER; }
  for (size_t at = 0; at < OUTPUT_UNITS; at++) { untouched &= units[at] == 0; }
  check(short_status == NARSIL_NEEDS_ROOM && needed == OUTPUT_UNITS && records[0] == 1 && untouched,
        "packed analysis negotiates capacity without publishing token records or text");
  const uint32_t expected[] = {1, POSITION, 0, TERM_LENGTH, TERM_LENGTH, SURFACE_LENGTH, 0, 0, UINT32_MAX};
  check(narsil_pack_tokens(&source, records, RECORDS, units, OUTPUT_UNITS, &needed) == NARSIL_OK &&
            memcmp(records, expected, sizeof expected) == 0 && memcmp(units, text + 1, sizeof units) == 0,
        "packed analysis rebases the copied suffix and removes original text and cache references");
  check(narsil_pack_tokens(&source, records, RECORDS, (uint16_t *)records, OUTPUT_UNITS, &needed) ==
                NARSIL_INVALID_ARGUMENT &&
            memcmp(records, expected, sizeof expected) == 0,
        "packed analysis refuses overlapping output before writing");
  token.term_offset = UINT32_MAX;
  check(narsil_pack_tokens(&source, records, RECORDS, units, OUTPUT_UNITS, &needed) == NARSIL_INVALID_ARGUMENT &&
            memcmp(records, expected, sizeof expected) == 0 && memcmp(units, text + 1, sizeof units) == 0,
        "packed analysis refuses a corrupt token span before writing");
}

static void exact_batch_boundaries(narsil_workspace *workspace, const narsil_term_dictionary *dictionary) {
  enum { QUERIES = 3, UNITS = 6, HIGH = 0xd800, LOW = 0xdc00 };
  uint16_t units[] = {'a', 'b', 'z', 'a', HIGH, LOW};
  uint32_t offsets[] = {0, 2, 3, UNITS};
  uint32_t output[] = {UINT32_MAX, UINT32_MAX, UINT32_MAX, UINT32_MAX};
  const uint32_t expected[] = {0, UINT32_MAX, 2, UINT32_MAX};
  check(narsil_lookup_exact_batch(workspace, dictionary, units, UNITS, offsets, QUERIES + 1, output, QUERIES + 1) ==
                NARSIL_OK &&
            memcmp(output, expected, sizeof expected) == 0,
        "exact batches retain an absent position between present Unicode terms");
  check(narsil_lookup_exact_batch(workspace, dictionary, units, UNITS, offsets, QUERIES + 1, output, QUERIES - 1) ==
                NARSIL_NEEDS_ROOM &&
            memcmp(output, expected, sizeof expected) == 0,
        "a short batch output preserves every word");
  check(narsil_lookup_exact_batch(workspace, dictionary, units, UNITS, offsets, QUERIES + 1, offsets, QUERIES + 1) ==
                NARSIL_INVALID_ARGUMENT &&
            offsets[1] == 2,
        "batch output cannot overwrite query boundaries");
  offsets[2] = 1;
  check(narsil_lookup_exact_batch(workspace, dictionary, units, UNITS, offsets, QUERIES + 1, output, QUERIES + 1) ==
                NARSIL_INVALID_ARGUMENT &&
            memcmp(output, expected, sizeof expected) == 0,
        "decreasing batch boundaries refuse before any output changes");
  check(narsil_lookup_exact_batch(workspace, dictionary, units, UNITS, offsets, SIZE_MAX, output, QUERIES + 1) ==
                NARSIL_INVALID_ARGUMENT &&
            memcmp(output, expected, sizeof expected) == 0,
        "batch boundary arithmetic refuses an unrepresentable region");
}

static void term_lookup_boundaries(narsil_workspace *workspace) {
  enum {
    TERM_TOTAL = 3,
    TOKEN_BYTES = 9,
    OUTPUT_WORDS = 4,
    HEAD_WORDS = 65536,
    TABLE_SLOTS = 8,
    HEADER_WORDS = 8,
    TERM_UNITS = 7,
    MULTIBYTE_START = 5,
    INVALID_UTF8 = 255,
    HIGH_SURROGATE = 0xd800,
    LOW_SURROGATE = 0xdc00
  };
  uint8_t tokens[] = "abaca\xf0\x90\x80\x80";
  uint32_t offsets[] = {0, 2, 4, TOKEN_BYTES};
  uint32_t frequencies[] = {2, 3, 1};
  uint32_t removed[] = {0, 1, 0};
  uint16_t text[] = {'a', 'b'};
  narsil_term_dictionary dictionary = {NULL,        tokens,     TOKEN_BYTES, offsets,   TERM_TOTAL + 1,
                                       frequencies, TERM_TOTAL, removed,     TERM_TOTAL};
  exact_batch_boundaries(workspace, &dictionary);
  packed_analysis_boundaries();
  narsil_term_lookup request = {&dictionary, text, 1, NARSIL_LOOKUP_PREFIX, TERM_TOTAL, 0, 0};
  uint32_t output[] = {UINT32_MAX, UINT32_MAX, UINT32_MAX, UINT32_MAX};
  uint32_t count = UINT32_MAX;
  check(narsil_lookup_terms(workspace, &request, output, OUTPUT_WORDS, &count) == NARSIL_OK && count == TERM_TOTAL &&
            output[0] == 0 && output[1] == 1 && output[2] == 2 && output[3] == UINT32_MAX,
        "prefix lookups subtract removals and resolve equal frequencies by code point order");
  request.operation = NARSIL_LOOKUP_TYPO;
  request.text_length = 2;
  request.tolerance = 1;
  request.prefix_length = 1;
  check(narsil_lookup_terms(workspace, &request, output, OUTPUT_WORDS, &count) == NARSIL_OK && count == TERM_TOTAL,
        "typo lookups count a supplementary code point as one substitution");
  request.tolerance = 0;
  check(narsil_lookup_terms(workspace, &request, output, OUTPUT_WORDS, &count) == NARSIL_OK && count == 1 &&
            output[0] == 0,
        "zero typo tolerance performs an exact lookup");
  uint32_t saved[OUTPUT_WORDS];
  memcpy(saved, output, sizeof saved);
  count = UINT32_MAX;
  check(narsil_lookup_terms(workspace, &request, output, 0, &count) == NARSIL_NEEDS_ROOM && count == UINT32_MAX &&
            memcmp(saved, output, sizeof saved) == 0,
        "a short exact output preserves both its count and entries");
  check(narsil_lookup_terms(workspace, &request, frequencies, TERM_TOTAL, &count) == NARSIL_INVALID_ARGUMENT &&
            frequencies[0] == 2,
        "lookup outputs cannot overwrite live frequencies");
  check(narsil_lookup_terms(workspace, &request, output, OUTPUT_WORDS, output) == NARSIL_INVALID_ARGUMENT &&
            memcmp(saved, output, sizeof saved) == 0,
        "lookup entries and count cannot overlap");
  check(narsil_document_frequency(&dictionary, 1, output, OUTPUT_WORDS) == NARSIL_OK && output[0] == 2,
        "document frequency returns the live count");
  check(narsil_document_frequency(&dictionary, TERM_TOTAL, output, OUTPUT_WORDS) == NARSIL_INVALID_ARGUMENT &&
            output[0] == 2,
        "document frequency refuses an ordinal outside the dictionary");
  request.operation = NARSIL_LOOKUP_PREFIX;
  request.text_length = 1;
  request.limit = 0;
  dictionary.removed_count--;
  check(narsil_lookup_terms(workspace, &request, output, OUTPUT_WORDS, &count) == NARSIL_INVALID_ARGUMENT,
        "a zero prefix limit validates removal region lengths");
  dictionary.removed_count++;
  request.limit = TERM_TOTAL;
  offsets[1] = UINT32_MAX;
  check(narsil_lookup_terms(workspace, &request, output, OUTPUT_WORDS, &count) == NARSIL_OK && count == 1 &&
            output[0] == 2,
        "lookups skip token spans outside their byte region");
  offsets[1] = 2;
  tokens[MULTIBYTE_START] = INVALID_UTF8;
  check(narsil_lookup_terms(workspace, &request, output, OUTPUT_WORDS, &count) == NARSIL_OK && count == 2,
        "lookups skip malformed UTF-8 without replacing it with another token");
  uint32_t header[] = {TERM_TOTAL, TERM_TOTAL, TABLE_SLOTS, 0, TERM_UNITS, 0, 0, 0};
  int32_t slots[TABLE_SLOTS] = {0};
  uint32_t starts[] = {0, 2, 4};
  uint32_t lengths[] = {2, 2, 3};
  uint32_t next[] = {0, 1, 2};
  static uint32_t heads[HEAD_WORDS];
  uint16_t units[] = {'a', 'b', 'a', 'c', 'a', HIGH_SURROGATE, LOW_SURROGATE};
  heads['a'] = TERM_TOTAL;
  narsil_term_table table = {header,     HEADER_WORDS, slots,      TABLE_SLOTS, starts,     TERM_TOTAL, lengths,
                             TERM_TOTAL, next,         TERM_TOTAL, heads,       HEAD_WORDS, units,      TERM_UNITS};
  dictionary.growing = &table;
  dictionary.tokens = NULL;
  dictionary.token_bytes = 0;
  dictionary.offsets = NULL;
  dictionary.offset_count = 0;
  check(narsil_lookup_terms(workspace, &request, output, OUTPUT_WORDS, &count) == NARSIL_OK && count == TERM_TOTAL &&
            output[0] == 0 && output[1] == 1 && output[2] == 2,
        "growing UTF-16 and frozen UTF-8 prefix lookups have the same order");
  next[0] = TERM_TOTAL;
  check(narsil_lookup_terms(workspace, &request, output, OUTPUT_WORDS, &count) == NARSIL_OK && count == TERM_TOTAL,
        "a corrupt prefix-chain cycle cannot duplicate results or prevent termination");
  request.operation = NARSIL_LOOKUP_TYPO;
  request.tolerance = UINT32_MAX;
  request.prefix_length = 0;
  request.text_length = 0;
  check(narsil_lookup_terms(workspace, &request, output, OUTPUT_WORDS, &count) == NARSIL_OK && count == TERM_TOTAL,
        "an empty typo term and the largest tolerance cannot overflow distance arithmetic");
}

static int finish(void) {
  if (failed_checks() > 0) {
    report("some checks did not pass");
    return 1;
  }
  if (puts("every check passed") == EOF) { return 1; }
  return 0;
}

int main(int argc, char **argv) {
  if (argc > 1 && strcmp(argv[1], ANALYSIS_THREADS_ONLY) == 0) {
    analysis_thread_checks();
    return finish();
  }
  if (argc > 1 && strcmp(argv[1], ALLOCATION_FAILURES_ONLY) == 0) {
    allocation_failure_checks();
    return finish();
  }
  narsil_workspace *workspace = NULL;
  check(narsil_workspace_create(&workspace) == NARSIL_OK, "narsil_workspace_create returns NARSIL_OK");
  check(narsil_core_abi_version() == NARSIL_CORE_ABI_VERSION, "the binary carries the header's ABI version");
  search_every_width(workspace);
  survive_corrupt_lists(workspace);
  refuse_bad_arguments(workspace);
  page_boundaries();
  fusion_boundaries(workspace);
  merge_boundaries(workspace);
  pinned_boundaries(workspace);
  facet_merge_boundaries(workspace);
  group_merge_boundaries(workspace);
  group_checks(workspace);
  sort_value_checks(workspace);
  sort_order_checks(workspace);
  boolean_facet_checks();
  numeric_facet_checks(workspace);
  enum_facet_checks(workspace);
  value_facet_checks(workspace);
  sort_select_checks(workspace);
  filter_checks(workspace);
  pattern_checks(workspace);
  term_lookup_boundaries(workspace);
  synonym_checks();
  phrase_checks(workspace);
  highlight_checks(workspace);
  paged_vector_checks(workspace);
  paged_posting_checks(workspace);
  segment_write_checks(workspace);
  frozen_removal_checks(workspace);
  field_merge_checks(workspace);
  keyword_region_boundaries(workspace);
  write_checks(workspace);
  record_checks(workspace);
  vector_file_checks(workspace);
  narsil_workspace_destroy(workspace);
  concurrent_checks();
  concurrent_writer_checks();
  analysis_thread_checks();
  return finish();
}
