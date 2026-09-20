#include "fixture.h"

#ifndef _WIN32

#include "../include/narsil_core.h"

#include <pthread.h>
#include <stddef.h>
#include <stdint.h>

#define WRITER_THREADS 2
#define READER_THREADS 2
#define SEARCHES_PER_READER 300
#define NODE_WRITE_HELD 1
#define REMOVED_STEP 9
#define RECALL_NUMERATOR 8
#define RECALL_DENOMINATOR 10

typedef struct {
  test_fixture *fixture;
  uint32_t thread_slot;
  int32_t first_ordinal;
  int work_done;
  narsil_status status;
} thread_work;

static void *place_every_other_node(void *argument) {
  thread_work *work = argument;
  narsil_workspace *workspace = NULL;
  if (narsil_workspace_create(&workspace) != NARSIL_OK) {
    work->status = NARSIL_OUT_OF_MEMORY;
    return NULL;
  }
  for (int32_t node = work->first_ordinal; node < NODES; node += WRITER_THREADS) {
    narsil_place_request request = {NARSIL_METRIC_EUCLIDEAN, node, fixture_top_layer(node), work->thread_slot, 0};
    narsil_status status = narsil_place(workspace, &work->fixture->graph, &work->fixture->store, &request);
    if (status != NARSIL_OK) {
      work->status = status;
      break;
    }
    work->work_done += 1;
    if (node % REMOVED_STEP == 0 && node > 0) {
      narsil_remove_request removal = {node, work->thread_slot};
      status = narsil_remove(&work->fixture->graph, &removal);
      if (status != NARSIL_OK) { work->status = status; }
    }
  }
  narsil_workspace_destroy(workspace);
  return NULL;
}

static void *search_beside_the_placers(void *argument) {
  thread_work *work = argument;
  narsil_workspace *workspace = NULL;
  if (narsil_workspace_create(&workspace) != NARSIL_OK) {
    work->status = NARSIL_OUT_OF_MEMORY;
    return NULL;
  }
  int32_t ordinals[CANDIDATES];
  double distances[CANDIDATES];
  for (int search = 0; search < SEARCHES_PER_READER && work->status == NARSIL_OK; search++) {
    const float *query = work->fixture->vectors + ((size_t)(search % NODES) * fixture_vector_stride_floats());
    narsil_candidates found = {ordinals, distances, CANDIDATES, 0};
    narsil_search_request request = {query, NARSIL_METRIC_EUCLIDEAN, CANDIDATES, work->thread_slot};
    work->status = narsil_search(workspace, &work->fixture->graph, &work->fixture->store, &request, &found);
    for (uint32_t i = 0; i < found.count; i++) {
      if (found.ordinals[i] < 0 || found.ordinals[i] >= NODES) { work->status = NARSIL_INVALID_ARGUMENT; }
    }
    work->work_done += 1;
  }
  narsil_workspace_destroy(workspace);
  return NULL;
}

static void check_the_finished_graph(test_fixture *fixture) {
  int32_t removed = 0;
  for (int32_t node = REMOVED_STEP; node < NODES; node += REMOVED_STEP) { removed += 1; }
  check(fixture->graph_header[NARSIL_GRAPH_WORD_NODE_COUNT] == NODES, "two placers raise nodeCount once for each node");
  check(fixture->graph_header[NARSIL_GRAPH_WORD_TOMBSTONE_COUNT] == removed,
        "removals beside placements raise tombstoneCount once for each ordinal");
  check(fixture->graph_header[NARSIL_GRAPH_WORD_LOCK] == 0, "graphLock is 0 once every thread finishes");
  check(fixture->graph_header[NARSIL_GRAPH_WORD_ENTRY_LOCK] == 0, "entryLock is 0 once every thread finishes");
  for (int32_t node = 0; node < NODES; node++) {
    check((fixture->locks[node] & NODE_WRITE_HELD) == 0, "no lock word keeps its writeHeld bit");
    const int32_t *list = fixture->level0 + ((size_t)node * BASE_LIST_WORDS);
    check(list[0] >= 0 && list[0] <= MAX_BASE_NEIGHBOURS, "a list that two placers wrote holds at most mMax0");
    for (int32_t i = 0; i < list[0] && i < MAX_BASE_NEIGHBOURS; i++) {
      check(list[i + 1] >= 0 && list[i + 1] < NODES && list[i + 1] != node,
            "a list that two placers wrote names other ordinals of the graph");
    }
  }
  for (uint32_t word = 0; word < THREAD_SLOTS * NARSIL_HELD_WORDS_PER_THREAD; word++) {
    check(fixture->held_locks[word] == 0 || word % NARSIL_HELD_WORDS_PER_THREAD == NARSIL_HELD_WORD_NODE_VALUE,
          "no thread records a lock once it finishes");
  }
}

static void check_the_graph_answers(test_fixture *fixture) {
  narsil_workspace *workspace = NULL;
  check(narsil_workspace_create(&workspace) == NARSIL_OK, "the test has a workspace");
  if (workspace == NULL) { return; }
  int32_t ordinals[CANDIDATES];
  double distances[CANDIDATES];
  int found_itself = 0;
  int live = 0;
  for (int32_t node = 0; node < NODES; node++) {
    if (fixture->tombstones[node] == 1) { continue; }
    live += 1;
    const float *query = fixture->vectors + ((size_t)node * fixture_vector_stride_floats());
    narsil_candidates found = {ordinals, distances, CANDIDATES, 0};
    narsil_search_request request = {query, NARSIL_METRIC_EUCLIDEAN, CANDIDATES, 0};
    if (narsil_search(workspace, &fixture->graph, &fixture->store, &request, &found) != NARSIL_OK) { continue; }
    found_itself += found.count > 0 && found.ordinals[0] == node;
  }
  check(found_itself * RECALL_DENOMINATOR >= live * RECALL_NUMERATOR,
        "a graph that two threads placed finds most live vectors as their own nearest");
  narsil_workspace_destroy(workspace);
}

void concurrent_writer_checks(void) {
  test_fixture *fixture = build_fixture_without_a_graph(0);
  check(fixture != NULL, "the fixture has its memory");
  if (fixture == NULL) { return; }
  pthread_t threads[WRITER_THREADS + READER_THREADS];
  thread_work work[WRITER_THREADS + READER_THREADS];
  for (int thread = 0; thread < WRITER_THREADS + READER_THREADS; thread++) {
    work[thread] = (thread_work){fixture, (uint32_t)thread, thread, 0, NARSIL_OK};
    void *(*body)(void *) = thread < WRITER_THREADS ? place_every_other_node : search_beside_the_placers;
    check(pthread_create(&threads[thread], NULL, body, &work[thread]) == 0, "the test starts a thread");
  }
  for (int thread = 0; thread < WRITER_THREADS + READER_THREADS; thread++) {
    check(pthread_join(threads[thread], NULL) == 0, "the test joins a thread");
    check(work[thread].status == NARSIL_OK, "every call beside another writer returns NARSIL_OK");
  }
  check(work[0].work_done + work[1].work_done == NODES, "the two placers place every node between them");
  check_the_finished_graph(fixture);
  check_the_graph_answers(fixture);
  release_fixture(fixture);
}

#else

void concurrent_writer_checks(void) {}

#endif
