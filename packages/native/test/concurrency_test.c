#include "fixture.h"

#ifndef _WIN32

#include "../include/narsil_core.h"

#include <pthread.h>
#include <stdatomic.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

#define READER_THREADS 3
#define SEARCHES_PER_READER 400
#define REWRITES 4000
#define NODE_WRITE_HELD 1
#define NODE_WRITER_WAITING 2
#define NODE_VERSION_STEP 4
#define REWRITTEN_NEIGHBOURS 6
#define QUERY_PERIOD 7

typedef struct {
  test_fixture *fixture;
  uint32_t thread_slot;
  int searches;
  int ordinals_inside_the_graph;
  narsil_status status;
} reader_state;

static _Atomic(int32_t) *lock_word(test_fixture *fixture, int32_t ordinal) {
  return (_Atomic(int32_t) *)(fixture->locks + ordinal);
}

static void hold_node(test_fixture *fixture, int32_t ordinal) {
  atomic_fetch_or(lock_word(fixture, ordinal), NODE_WRITE_HELD);
}

static void release_node(test_fixture *fixture, int32_t ordinal) {
  _Atomic(int32_t) *word = lock_word(fixture, ordinal);
  int32_t held = atomic_load(word);
  atomic_store(word, (held & ~(NODE_WRITE_HELD | NODE_WRITER_WAITING)) + NODE_VERSION_STEP);
}

static void rewrite_one_list(test_fixture *fixture, int32_t ordinal, int32_t round) {
  int32_t *list = fixture->level0 + ((size_t)ordinal * (MAX_BASE_NEIGHBOURS + NARSIL_LIST_WORDS_OVER_NEIGHBOURS));
  hold_node(fixture, ordinal);
  list[0] = round % 2 == 0 ? REWRITTEN_NEIGHBOURS : MAX_BASE_NEIGHBOURS;
  for (int32_t i = 0; i < MAX_BASE_NEIGHBOURS; i++) { list[i + 1] = (ordinal + ((i + 1) * (round + 1))) % NODES; }
  release_node(fixture, ordinal);
}

static void *search_beside_the_writer(void *argument) {
  reader_state *state = argument;
  narsil_workspace *workspace = NULL;
  if (narsil_workspace_create(&workspace) != NARSIL_OK) {
    state->status = NARSIL_OUT_OF_MEMORY;
    return NULL;
  }
  int32_t ordinals[CANDIDATES];
  double distances[CANDIDATES];
  float query[DIMENSION];
  for (int i = 0; i < DIMENSION; i++) { query[i] = (float)(i % QUERY_PERIOD) / (float)QUERY_PERIOD; }

  for (int search = 0; search < SEARCHES_PER_READER; search++) {
    narsil_candidates found = {ordinals, distances, CANDIDATES, 0};
    narsil_search_request request = {query, NARSIL_METRIC_COSINE, CANDIDATES, state->thread_slot};
    narsil_status status = narsil_search(workspace, &state->fixture->graph, &state->fixture->store, &request, &found);
    if (status != NARSIL_OK) {
      state->status = status;
      break;
    }
    state->searches += 1;
    for (uint32_t i = 0; i < found.count; i++) {
      if (found.ordinals[i] >= 0 && found.ordinals[i] < NODES) { state->ordinals_inside_the_graph += 1; }
    }
  }
  narsil_workspace_destroy(workspace);
  return NULL;
}

void concurrent_checks(void) {
  test_fixture *fixture = build_fixture(4);
  check(fixture != NULL, "the fixture has its memory");
  if (fixture == NULL) { return; }

  pthread_t readers[READER_THREADS];
  reader_state states[READER_THREADS];
  for (int reader = 0; reader < READER_THREADS; reader++) {
    states[reader] = (reader_state){fixture, (uint32_t)reader, 0, 0, NARSIL_OK};
    check(pthread_create(&readers[reader], NULL, search_beside_the_writer, &states[reader]) == 0,
          "the test starts a reader thread");
  }

  for (int32_t round = 0; round < REWRITES; round++) { rewrite_one_list(fixture, round % NODES, round); }

  for (int reader = 0; reader < READER_THREADS; reader++) {
    check(pthread_join(readers[reader], NULL) == 0, "the test joins a reader thread");
    check(states[reader].status == NARSIL_OK, "every search beside a writer returns NARSIL_OK");
    check(states[reader].searches == SEARCHES_PER_READER, "every reader finishes its searches");
    check(states[reader].ordinals_inside_the_graph > 0, "a search beside a writer returns ordinals");
  }
  check(atomic_load(lock_word(fixture, 0)) % NODE_VERSION_STEP == 0, "a rewritten lock word holds no writer bit");
  release_fixture(fixture);
}

#else

void concurrent_checks(void) {}

#endif
