#include "fixture.h"

#ifndef _WIN32

#include "../include/narsil_core.h"

#include <math.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define WRITER_THREADS 2
#define READER_THREADS 2
#define SEARCHES_PER_READER 300
#define NODE_WRITE_HELD 1
#define REMOVED_STEP 9
#define RECALL_NUMERATOR 8
#define RECALL_DENOMINATOR 10
#define FIRST_PLACEMENT_RACES 2000
#define FIRST_PLACEMENT_LAYER 0
#define RAISED_ENTRY_PLACEMENT_RACES 500
#define NEAR_ORDINAL 0
#define BESIDE_ORDINAL 1
#define FAR_ORDINAL 40000
#define RAISING_ORDINAL (FAR_ORDINAL + 1)
#define WIDE_GRAPH_SLOTS (RAISING_ORDINAL + 1)
#define WIDE_GRAPH_NODES 4

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
    narsil_search_request request = {query,      NARSIL_METRIC_EUCLIDEAN, CANDIDATES, work->thread_slot, {NULL, 0},
                                     FIXTURE_PIN};
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
    narsil_search_request request = {query, NARSIL_METRIC_EUCLIDEAN, CANDIDATES, 0, {NULL, 0}, FIXTURE_PIN};
    if (narsil_search(workspace, &fixture->graph, &fixture->store, &request, &found) != NARSIL_OK) { continue; }
    found_itself += found.count > 0 && found.ordinals[0] == node;
  }
  check(found_itself * RECALL_DENOMINATOR >= live * RECALL_NUMERATOR,
        "a graph that two threads placed finds most live vectors as their own nearest");
  narsil_workspace_destroy(workspace);
}

typedef struct {
  const narsil_graph *graph;
  const narsil_store *store;
} stored_graph;

typedef struct {
  stored_graph placed_into;
  narsil_workspace *workspace;
  atomic_int *arrived;
  narsil_place_request request;
  narsil_status status;
} gated_placement;

static void *place_at_the_start_gate(void *argument) {
  gated_placement *placement = argument;
  atomic_fetch_add(placement->arrived, 1);
  while (atomic_load(placement->arrived) < WRITER_THREADS) {}
  placement->status = narsil_place(placement->workspace, placement->placed_into.graph, placement->placed_into.store,
                                   &placement->request);
  return NULL;
}

static int place_both_at_once(gated_placement placements[WRITER_THREADS]) {
  atomic_int arrived = 0;
  pthread_t threads[WRITER_THREADS];
  int started = 0;
  for (int thread = 0; thread < WRITER_THREADS && started == thread; thread++) {
    placements[thread].arrived = &arrived;
    placements[thread].status = NARSIL_INVALID_ARGUMENT;
    started += pthread_create(&threads[thread], NULL, place_at_the_start_gate, &placements[thread]) == 0;
  }
  if (started != WRITER_THREADS) { atomic_store(&arrived, WRITER_THREADS); }
  for (int thread = 0; thread < started; thread++) { (void)pthread_join(threads[thread], NULL); }
  return started == WRITER_THREADS && placements[0].status == NARSIL_OK && placements[1].status == NARSIL_OK;
}

static int search_finds_every_node(narsil_workspace *workspace, stored_graph searched, const float *query,
                                   uint32_t nodes) {
  int32_t ordinals[CANDIDATES];
  double distances[CANDIDATES];
  narsil_candidates found = {ordinals, distances, CANDIDATES, 0};
  narsil_search_request request = {query, NARSIL_METRIC_EUCLIDEAN, CANDIDATES, 0, {NULL, 0}, FIXTURE_PIN};
  if (narsil_search(workspace, searched.graph, searched.store, &request, &found) != NARSIL_OK) { return 0; }
  return found.count == nodes;
}

static int race_the_first_placements(narsil_workspace *const workspaces[WRITER_THREADS]) {
  test_fixture *fixture = build_fixture_without_a_graph(0);
  if (fixture == NULL) { return 0; }
  stored_graph placed_into = {&fixture->graph, &fixture->store};
  gated_placement placements[WRITER_THREADS];
  for (int32_t thread = 0; thread < WRITER_THREADS; thread++) {
    narsil_place_request request = {NARSIL_METRIC_EUCLIDEAN, thread, FIRST_PLACEMENT_LAYER, (uint32_t)thread, 0};
    placements[thread] = (gated_placement){placed_into, workspaces[thread], NULL, request, NARSIL_INVALID_ARGUMENT};
  }
  int linked = place_both_at_once(placements);
  for (int32_t node = 0; linked && node < WRITER_THREADS; node++) {
    const float *query = fixture->vectors + ((size_t)node * fixture_vector_stride_floats());
    linked = search_finds_every_node(workspaces[0], placed_into, query, WRITER_THREADS);
  }
  release_fixture(fixture);
  return linked;
}

static void first_placement_race_checks(void) {
  narsil_workspace *workspaces[WRITER_THREADS] = {NULL, NULL};
  int created =
      narsil_workspace_create(&workspaces[0]) == NARSIL_OK && narsil_workspace_create(&workspaces[1]) == NARSIL_OK;
  check(created, "the test has a workspace for each placer");
  int unreachable = 0;
  for (int race = 0; created && race < FIRST_PLACEMENT_RACES; race++) {
    unreachable += !race_the_first_placements(workspaces);
  }
  check(unreachable == 0, "two threads that place the first two nodes at once leave each one reachable by search");
  narsil_workspace_destroy(workspaces[0]);
  narsil_workspace_destroy(workspaces[1]);
}

typedef struct {
  test_fixture *fixture;
  narsil_workspace *workspace;
  atomic_int *arrived;
  atomic_int *placed;
  int empty_searches;
} raised_entry_search;

static void *search_while_the_entry_rises(void *argument) {
  raised_entry_search *searcher = argument;
  int32_t ordinals[CANDIDATES];
  double distances[CANDIDATES];
  narsil_search_request request = {
      searcher->fixture->vectors, NARSIL_METRIC_EUCLIDEAN, CANDIDATES, 1, {NULL, 0}, FIXTURE_PIN};
  atomic_fetch_add(searcher->arrived, 1);
  while (atomic_load(searcher->arrived) < WRITER_THREADS) {}
  int last = 0;
  while (!last) {
    last = atomic_load(searcher->placed);
    narsil_candidates found = {ordinals, distances, CANDIDATES, 0};
    narsil_status status =
        narsil_search(searcher->workspace, &searcher->fixture->graph, &searcher->fixture->store, &request, &found);
    searcher->empty_searches += status != NARSIL_OK || found.count == 0;
  }
  return NULL;
}

static int race_a_search_with_a_raised_entry(narsil_workspace *const workspaces[WRITER_THREADS]) {
  test_fixture *fixture = build_fixture_without_a_graph(0);
  if (fixture == NULL) { return 0; }
  narsil_place_request first = {NARSIL_METRIC_EUCLIDEAN, 0, FIRST_PLACEMENT_LAYER, 0, 0};
  int clean = narsil_place(workspaces[0], &fixture->graph, &fixture->store, &first) == NARSIL_OK;
  atomic_int arrived = 0;
  atomic_int placed = 0;
  raised_entry_search searcher = {fixture, workspaces[1], &arrived, &placed, 0};
  pthread_t thread;
  int started = clean && pthread_create(&thread, NULL, search_while_the_entry_rises, &searcher) == 0;
  if (started) {
    atomic_fetch_add(&arrived, 1);
    while (atomic_load(&arrived) < WRITER_THREADS) {}
    narsil_place_request higher = {NARSIL_METRIC_EUCLIDEAN, 1, FIRST_PLACEMENT_LAYER + 1, 0, 0};
    clean = narsil_place(workspaces[0], &fixture->graph, &fixture->store, &higher) == NARSIL_OK;
    atomic_store(&placed, 1);
    (void)pthread_join(thread, NULL);
  }
  release_fixture(fixture);
  return started && clean && searcher.empty_searches == 0;
}

static void raised_entry_search_checks(void) {
  narsil_workspace *workspaces[WRITER_THREADS] = {NULL, NULL};
  int created =
      narsil_workspace_create(&workspaces[0]) == NARSIL_OK && narsil_workspace_create(&workspaces[1]) == NARSIL_OK;
  check(created, "the test has a workspace for the placer and the searcher");
  int failed = 0;
  for (int race = 0; created && race < FIRST_PLACEMENT_RACES; race++) {
    failed += !race_a_search_with_a_raised_entry(workspaces);
  }
  check(failed == 0, "a search beside a placement that raises the entry point still finds the nodes already placed");
  narsil_workspace_destroy(workspaces[0]);
  narsil_workspace_destroy(workspaces[1]);
}

typedef struct {
  int32_t graph_header[NARSIL_GRAPH_HEADER_WORDS];
  int32_t store_header[NARSIL_STORE_HEADER_WORDS];
  int32_t held_locks[THREAD_SLOTS * NARSIL_HELD_WORDS_PER_THREAD];
  int32_t upper[UPPER_LIST_WORDS];
  float centroid[DIMENSION];
  int64_t pins[THREAD_SLOTS];
  const float *vector_blocks[1];
  float *vectors;
  double *magnitudes;
  uint8_t *present;
  int64_t *born_at;
  int64_t *retired_at;
  narsil_graph graph;
  narsil_store store;
} wide_graph;

static const int32_t wide_graph_ordinals[WIDE_GRAPH_NODES] = {NEAR_ORDINAL, BESIDE_ORDINAL, FAR_ORDINAL,
                                                              RAISING_ORDINAL};

static void release_wide_graph(wide_graph *wide) {
  if (wide == NULL) { return; }
  free(wide->graph.node_levels);
  free(wide->graph.level0);
  free(wide->graph.upper_base);
  free(wide->graph.locks);
  free(wide->graph.tombstones);
  free(wide->graph.incoming);
  free(wide->graph.nearest_link_due);
  free(wide->store.code_present);
  free(wide->vectors);
  free(wide->magnitudes);
  free(wide->present);
  free(wide->born_at);
  free(wide->retired_at);
  free(wide);
}

static int hold_wide_arrays(wide_graph *wide) {
  narsil_graph *graph = &wide->graph;
  graph->node_levels = calloc(WIDE_GRAPH_SLOTS, sizeof *graph->node_levels);
  graph->level0 = calloc((size_t)WIDE_GRAPH_SLOTS * BASE_LIST_WORDS, sizeof *graph->level0);
  graph->upper_base = calloc(WIDE_GRAPH_SLOTS, sizeof *graph->upper_base);
  graph->locks = calloc(WIDE_GRAPH_SLOTS, sizeof *graph->locks);
  graph->tombstones = calloc(WIDE_GRAPH_SLOTS, sizeof *graph->tombstones);
  graph->incoming = calloc(WIDE_GRAPH_SLOTS, sizeof *graph->incoming);
  graph->nearest_link_due = calloc(WIDE_GRAPH_SLOTS, sizeof *graph->nearest_link_due);
  wide->store.code_present = calloc(WIDE_GRAPH_SLOTS, sizeof *wide->store.code_present);
  wide->vectors = calloc((size_t)WIDE_GRAPH_SLOTS * fixture_vector_stride_floats(), sizeof *wide->vectors);
  wide->magnitudes = calloc(WIDE_GRAPH_SLOTS, sizeof *wide->magnitudes);
  wide->present = calloc(WIDE_GRAPH_SLOTS, sizeof *wide->present);
  wide->born_at = calloc(WIDE_GRAPH_SLOTS, sizeof *wide->born_at);
  wide->retired_at = calloc(WIDE_GRAPH_SLOTS, sizeof *wide->retired_at);
  return graph->node_levels != NULL && graph->level0 != NULL && graph->upper_base != NULL && graph->locks != NULL &&
         graph->tombstones != NULL && graph->incoming != NULL && graph->nearest_link_due != NULL &&
         wide->store.code_present != NULL && wide->vectors != NULL && wide->magnitudes != NULL &&
         wide->present != NULL && wide->born_at != NULL && wide->retired_at != NULL;
}

static void write_wide_vectors(wide_graph *wide) {
  for (int node = 0; node < WIDE_GRAPH_NODES; node++) {
    int32_t ordinal = wide_graph_ordinals[node];
    float *vector = wide->vectors + ((size_t)ordinal * fixture_vector_stride_floats());
    double squares = 0;
    for (int i = 0; i < DIMENSION; i++) {
      vector[i] = (random_unit() * 2) - 1;
      squares += (double)vector[i] * (double)vector[i];
    }
    wide->magnitudes[ordinal] = sqrt(squares);
    wide->present[ordinal] = 1;
    wide->born_at[ordinal] = FIXTURE_BORN_SEQUENCE;
  }
}

static void forget_the_wide_graph(wide_graph *wide) {
  const narsil_graph *graph = &wide->graph;
  for (int node = 0; node < WIDE_GRAPH_NODES; node++) {
    int32_t ordinal = wide_graph_ordinals[node];
    graph->node_levels[ordinal] = 0;
    memset(graph->level0 + ((size_t)ordinal * BASE_LIST_WORDS), 0, BASE_LIST_WORDS * sizeof *graph->level0);
    graph->upper_base[ordinal] = 0;
    graph->incoming[ordinal] = 0;
    graph->nearest_link_due[ordinal] = 0;
  }
  memset(wide->upper, 0, sizeof wide->upper);
  wide->graph_header[NARSIL_GRAPH_WORD_ENTRY_POINT] = -1;
  wide->graph_header[NARSIL_GRAPH_WORD_TOP_LAYER] = -1;
  wide->graph_header[NARSIL_GRAPH_WORD_NODE_COUNT] = 0;
  wide->graph_header[NARSIL_GRAPH_WORD_UNLINKED_NODES] = 0;
  wide->graph_header[NARSIL_GRAPH_WORD_UPPER_USED] = 0;
  wide->graph_header[NARSIL_GRAPH_WORD_SLOTS] = 0;
}

static wide_graph *build_wide_graph(void) {
  wide_graph *wide = calloc(1, sizeof *wide);
  if (wide == NULL) { return NULL; }
  if (!hold_wide_arrays(wide)) {
    release_wide_graph(wide);
    return NULL;
  }
  write_wide_vectors(wide);
  wide->vector_blocks[0] = wide->vectors;
  wide->graph_header[NARSIL_GRAPH_WORD_M] = MAX_NEIGHBOURS;
  wide->graph_header[NARSIL_GRAPH_WORD_MMAX0] = MAX_BASE_NEIGHBOURS;
  wide->graph_header[NARSIL_GRAPH_WORD_EF_CONSTRUCTION] = CANDIDATES;
  wide->graph_header[NARSIL_GRAPH_WORD_SLOT_CAPACITY] = WIDE_GRAPH_SLOTS;
  wide->graph_header[NARSIL_GRAPH_WORD_UPPER_CAPACITY] = UPPER_LIST_WORDS;
  wide->store_header[NARSIL_STORE_WORD_SLOTS] = WIDE_GRAPH_SLOTS;
  wide->store_header[NARSIL_STORE_WORD_LIVE_COUNT] = WIDE_GRAPH_NODES;
  wide->graph.header = wide->graph_header;
  wide->graph.upper = wide->upper;
  wide->graph.held_locks = wide->held_locks;
  wide->graph.thread_slots = THREAD_SLOTS;
  wide->store.header = wide->store_header;
  wide->store.dimension = DIMENSION;
  wide->store.centroid = wide->centroid;
  wide->store.vector_blocks = wide->vector_blocks;
  wide->store.vector_block_count = 1;
  wide->store.vectors_per_block = WIDE_GRAPH_SLOTS;
  wide->store.vector_stride_floats = fixture_vector_stride_floats();
  wide->store.magnitudes = wide->magnitudes;
  wide->store.present = wide->present;
  wide->store.born_at = wide->born_at;
  wide->store.retired_at = wide->retired_at;
  wide->store.pins = wide->pins;
  wide->store.pin_slots = THREAD_SLOTS;
  forget_the_wide_graph(wide);
  return wide;
}

static int race_a_placement_with_a_raised_entry(wide_graph *wide, narsil_workspace *raising) {
  forget_the_wide_graph(wide);
  narsil_workspace *beside = NULL;
  if (narsil_workspace_create(&beside) != NARSIL_OK) { return 0; }
  stored_graph placed_into = {&wide->graph, &wide->store};
  narsil_place_request near = {NARSIL_METRIC_EUCLIDEAN, NEAR_ORDINAL, FIRST_PLACEMENT_LAYER, 0, 0};
  narsil_place_request far = {NARSIL_METRIC_EUCLIDEAN, FAR_ORDINAL, FIRST_PLACEMENT_LAYER, 1, 0};
  int linked = narsil_place(beside, &wide->graph, &wide->store, &near) == NARSIL_OK &&
               narsil_place(raising, &wide->graph, &wide->store, &far) == NARSIL_OK;
  gated_placement placements[WRITER_THREADS] = {
      {placed_into,
       beside,
       NULL,
       {NARSIL_METRIC_EUCLIDEAN, BESIDE_ORDINAL, FIRST_PLACEMENT_LAYER, 0, 0},
       NARSIL_INVALID_ARGUMENT},
      {placed_into,
       raising,
       NULL,
       {NARSIL_METRIC_EUCLIDEAN, RAISING_ORDINAL, FIRST_PLACEMENT_LAYER + 1, 1, 0},
       NARSIL_INVALID_ARGUMENT},
  };
  linked = linked && place_both_at_once(placements);
  const float *query = wide->vectors + ((size_t)BESIDE_ORDINAL * fixture_vector_stride_floats());
  linked = linked && search_finds_every_node(raising, placed_into, query, WIDE_GRAPH_NODES);
  narsil_workspace_destroy(beside);
  return linked;
}

static void raised_entry_placement_checks(void) {
  wide_graph *wide = build_wide_graph();
  narsil_workspace *raising = NULL;
  int created = wide != NULL && narsil_workspace_create(&raising) == NARSIL_OK;
  check(created, "the test has a wide graph and a workspace for the placement that raises the entry point");
  int unlinked = 0;
  for (int race = 0; created && race < RAISED_ENTRY_PLACEMENT_RACES; race++) {
    unlinked += !race_a_placement_with_a_raised_entry(wide, raising);
  }
  check(unlinked == 0, "a placement beside a placement that raises the entry point still links its node");
  narsil_workspace_destroy(raising);
  release_wide_graph(wide);
}

void concurrent_writer_checks(void) {
  first_placement_race_checks();
  raised_entry_search_checks();
  raised_entry_placement_checks();
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
