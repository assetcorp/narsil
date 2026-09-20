#include "fixture.h"

#include "../include/narsil_core.h"

#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

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
    narsil_search_request request = {query, metric, CANDIDATES, SEARCH_THREAD_SLOT};
    check(narsil_search(workspace, &fixture->graph, &fixture->store, &request, &found) == NARSIL_OK,
          "search returns NARSIL_OK");
    check(found.count == CANDIDATES, "search fills the candidate count");
    check_sorted(&found, "search returns the nearest first");
    check(fixture->graph_header[NARSIL_GRAPH_WORD_LOCK] == 0, "the graph lock word is 0 after a search");
    check(fixture->held_locks[(SEARCH_THREAD_SLOT * NARSIL_HELD_WORDS_PER_THREAD) + NARSIL_HELD_WORD_GRAPH] == 0,
          "the held-lock record is 0 after a search");

    double scored[CANDIDATES];
    narsil_score_request scoring = {query, metric, ordinals, found.count};
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
  narsil_search_request request = {query, NARSIL_METRIC_COSINE, CANDIDATES, 0};
  check(narsil_search(workspace, &fixture->graph, &fixture->store, &request, &found) == NARSIL_OK,
        "search returns NARSIL_OK over corrupt lists");
  check_sorted(&found, "search over corrupt lists returns ordinals inside the graph");
  for (uint32_t i = 0; i < found.count; i++) {
    check(found.ordinals[i] != TOMBSTONED_ORDINAL, "search skips a tombstone");
    check(found.ordinals[i] != UNRECORDED_ORDINAL, "search skips an ordinal with no record");
  }

  int32_t unsorted[3] = {-1, RESCORED_ORDINAL_PAST_THE_STORE, RESCORED_ORDINAL};
  double scored[3];
  narsil_score_request scoring = {query, NARSIL_METRIC_EUCLIDEAN, unsorted, 3};
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
  narsil_search_request request = {query, NARSIL_METRIC_COSINE, CANDIDATES, 0};
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
  narsil_score_request scoring = {query, UNKNOWN_METRIC, ordinals, 1};
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

int main(void) {
  narsil_workspace *workspace = NULL;
  check(narsil_workspace_create(&workspace) == NARSIL_OK, "narsil_workspace_create returns NARSIL_OK");
  check(narsil_core_abi_version() == NARSIL_CORE_ABI_VERSION, "the binary carries the header's ABI version");
  search_every_width(workspace);
  survive_corrupt_lists(workspace);
  refuse_bad_arguments(workspace);
  write_checks(workspace);
  record_checks(workspace);
  vector_file_checks(workspace);
  narsil_workspace_destroy(workspace);
  concurrent_checks();
  concurrent_writer_checks();
  if (failed_checks() > 0) {
    report("some checks did not pass");
    return 1;
  }
  if (puts("every check passed") == EOF) { return 1; }
  return 0;
}
