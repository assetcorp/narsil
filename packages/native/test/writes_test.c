#include "fixture.h"

#include "../include/narsil_core.h"

#include <math.h>
#include <stddef.h>
#include <stdint.h>

#define WRITER_THREAD_SLOT 3
#define NEAREST_IS_ITSELF_FLOOR ((NODES * 9) / 10)
#define REMOVED_STEP 5
#define NOTHING_HELD 0
#define NOTHING_REMOVED 0
#define WAKES_KEPT 8
#define WRITE_HELD_BIT 1
#define WRITER_WAITING_BIT 2

static narsil_status place_one(narsil_workspace *workspace, test_fixture *fixture, int32_t ordinal) {
  narsil_place_request request = {NARSIL_METRIC_EUCLIDEAN, ordinal, fixture_top_layer(ordinal), WRITER_THREAD_SLOT, 0};
  return narsil_place(workspace, &fixture->graph, &fixture->store, &request);
}

static narsil_status remove_one(test_fixture *fixture, int32_t ordinal) {
  narsil_remove_request request = {ordinal, WRITER_THREAD_SLOT};
  return narsil_remove(&fixture->graph, &request);
}

static void place_every_node(narsil_workspace *workspace, test_fixture *fixture) {
  for (int32_t node = 0; node < NODES; node++) {
    check(place_one(workspace, fixture, node) == NARSIL_OK, "place returns NARSIL_OK");
  }
}

static uint32_t list_count(const test_fixture *fixture, int32_t node) {
  return (uint32_t)fixture->level0[(size_t)node * BASE_LIST_WORDS];
}

static void check_every_list(const test_fixture *fixture, int removed_step) {
  for (int32_t node = 0; node < NODES; node++) {
    if (fixture->node_levels[node] == 0) { continue; }
    const int32_t *list = fixture->level0 + ((size_t)node * BASE_LIST_WORDS);
    check(list[0] >= 0 && list[0] <= MAX_BASE_NEIGHBOURS, "a base list holds no more neighbours than mMax0");
    int live_neighbours = 0;
    for (int32_t i = 0; i < list[0]; i++) {
      int32_t neighbour = list[i + 1];
      check(neighbour >= 0 && neighbour < NODES && neighbour != node, "a neighbour is another ordinal of the graph");
      if (neighbour >= 0 && neighbour < NODES && fixture->node_levels[neighbour] != 0) { live_neighbours += 1; }
    }
    if (removed_step == 0) { check(live_neighbours == list[0], "a neighbour is a node that the graph holds"); }
    check(live_neighbours > 0, "a node keeps a neighbour that the graph holds");
  }
}

static int nearest_is_itself(narsil_workspace *workspace, test_fixture *fixture, int32_t node) {
  int32_t ordinals[CANDIDATES];
  double distances[CANDIDATES];
  narsil_candidates found = {ordinals, distances, CANDIDATES, 0};
  const float *query = fixture->vectors + ((size_t)node * fixture_vector_stride_floats());
  narsil_search_request request = {query, NARSIL_METRIC_EUCLIDEAN, CANDIDATES, 0};
  if (narsil_search(workspace, &fixture->graph, &fixture->store, &request, &found) != NARSIL_OK) { return 0; }
  return found.count > 0 && found.ordinals[0] == node;
}

static void build_a_graph_by_placement(narsil_workspace *workspace) {
  test_fixture *fixture = build_fixture_without_a_graph(0);
  check(fixture != NULL, "the fixture has its memory");
  if (fixture == NULL) { return; }
  place_every_node(workspace, fixture);
  check(fixture->graph_header[NARSIL_GRAPH_WORD_NODE_COUNT] == NODES, "place raises nodeCount by 1 for each node");
  check(fixture->graph_header[NARSIL_GRAPH_WORD_SLOTS] == NODES, "place raises slots past the highest ordinal");
  check(fixture->graph_header[NARSIL_GRAPH_WORD_ENTRY_POINT] == 0, "the first node with the top layer is the entry");
  check(fixture->graph_header[NARSIL_GRAPH_WORD_TOP_LAYER] == 1, "the entry point's top layer is the graph's");
  check(fixture->graph_header[NARSIL_GRAPH_WORD_LOCK] == NOTHING_HELD, "graphLock is 0 after every placement");
  check(fixture->held_locks[(WRITER_THREAD_SLOT * NARSIL_HELD_WORDS_PER_THREAD) + NARSIL_HELD_WORD_NODE] ==
            NOTHING_HELD,
        "the held-lock record names no node after every placement");
  check_every_list(fixture, NOTHING_REMOVED);
  int found_itself = 0;
  for (int32_t node = 0; node < NODES; node++) { found_itself += nearest_is_itself(workspace, fixture, node); }
  check(found_itself >= NEAREST_IS_ITSELF_FLOOR,
        "a search of the placed graph finds most vectors as their own nearest");
  check(place_one(workspace, fixture, 0) == NARSIL_INVALID_ARGUMENT, "place refuses an ordinal that holds a node");
  release_fixture(fixture);
}

static void ask_for_room(narsil_workspace *workspace) {
  test_fixture *fixture = build_fixture_without_a_graph(0);
  check(fixture != NULL, "the fixture has its memory");
  if (fixture == NULL) { return; }
  fixture->graph_header[NARSIL_GRAPH_WORD_UPPER_CAPACITY] = 0;
  check(place_one(workspace, fixture, 0) == NARSIL_NEEDS_ROOM,
        "place returns NARSIL_NEEDS_ROOM where upperCapacity holds no room for the node's upper list");
  fixture->graph_header[NARSIL_GRAPH_WORD_UPPER_CAPACITY] = UPPER_WORDS;
  fixture->graph_header[NARSIL_GRAPH_WORD_SLOT_CAPACITY] = 1;
  check(place_one(workspace, fixture, 1) == NARSIL_NEEDS_ROOM,
        "place returns NARSIL_NEEDS_ROOM for an ordinal at slotCapacity");
  check(fixture->graph_header[NARSIL_GRAPH_WORD_NODE_COUNT] == 0 &&
            fixture->graph_header[NARSIL_GRAPH_WORD_UPPER_USED] == 0 && fixture->node_levels[1] == 0,
        "place leaves the graph unchanged where it returns NARSIL_NEEDS_ROOM");
  release_fixture(fixture);
}

static void remove_then_compact(narsil_workspace *workspace) {
  test_fixture *fixture = build_fixture_without_a_graph(0);
  check(fixture != NULL, "the fixture has its memory");
  if (fixture == NULL) { return; }
  place_every_node(workspace, fixture);
  int32_t removed = 0;
  for (int32_t node = 0; node < NODES; node += REMOVED_STEP) {
    check(remove_one(fixture, node) == NARSIL_OK, "remove returns NARSIL_OK");
    removed += 1;
  }
  check(remove_one(fixture, 0) == NARSIL_OK, "remove takes a tombstoned ordinal");
  check(fixture->graph_header[NARSIL_GRAPH_WORD_TOMBSTONE_COUNT] == removed,
        "remove raises tombstoneCount once for each ordinal");
  int32_t entry = fixture->graph_header[NARSIL_GRAPH_WORD_ENTRY_POINT];
  check(entry > 0 && fixture->tombstones[entry] == 0 && fixture_top_layer(entry) == 1,
        "remove moves the entry point to the live node with the highest top layer");

  narsil_compact_request compaction = {NARSIL_METRIC_EUCLIDEAN, WRITER_THREAD_SLOT};
  check(narsil_compact(workspace, &fixture->graph, &fixture->store, &compaction) == NARSIL_GRAPH_NOT_HELD_ALONE,
        "compact changes nothing while graphLock is not -1");
  check(fixture->graph_header[NARSIL_GRAPH_WORD_NODE_COUNT] == NODES, "a refused compact leaves nodeCount alone");

  fixture->graph_header[NARSIL_GRAPH_WORD_LOCK] = NARSIL_GRAPH_HELD_ALONE;
  check(narsil_compact(workspace, &fixture->graph, &fixture->store, &compaction) == NARSIL_OK,
        "compact returns NARSIL_OK while the caller holds the graph alone");
  fixture->graph_header[NARSIL_GRAPH_WORD_LOCK] = NOTHING_HELD;
  check(fixture->graph_header[NARSIL_GRAPH_WORD_NODE_COUNT] == NODES - removed, "compact lowers nodeCount");
  check(fixture->graph_header[NARSIL_GRAPH_WORD_TOMBSTONE_COUNT] == 0, "compact lowers tombstoneCount to 0");
  for (int32_t node = 0; node < NODES; node += REMOVED_STEP) {
    check(fixture->node_levels[node] == 0 && fixture->tombstones[node] == 0, "compact takes the node out");
  }
  check_every_list(fixture, REMOVED_STEP);
  check(list_count(fixture, 1) > 0, "compact leaves a live node its neighbours");
  check(nearest_is_itself(workspace, fixture, 1), "a search of the compacted graph finds a live vector");
  release_fixture(fixture);
}

static void place_over_a_tombstone(narsil_workspace *workspace) {
  test_fixture *fixture = build_fixture_without_a_graph(0);
  check(fixture != NULL, "the fixture has its memory");
  if (fixture == NULL) { return; }
  fixture->tombstones[2] = 1;
  fixture->graph_header[NARSIL_GRAPH_WORD_TOMBSTONE_COUNT] = 1;
  check(place_one(workspace, fixture, 2) == NARSIL_OK, "place returns NARSIL_OK for a tombstoned ordinal");
  check(fixture->tombstones[2] == 0 && fixture->graph_header[NARSIL_GRAPH_WORD_TOMBSTONE_COUNT] == 0,
        "place lowers tombstoneCount and stores 0 in the tombstone");
  check(fixture->graph_header[NARSIL_GRAPH_WORD_ENTRY_POINT] == 2, "place stores the first node as the entry point");

  narsil_place_request alone = {NARSIL_METRIC_EUCLIDEAN, 3, 0, WRITER_THREAD_SLOT, 1};
  check(narsil_place(workspace, &fixture->graph, &fixture->store, &alone) == NARSIL_GRAPH_NOT_HELD_ALONE,
        "place refuses a caller that claims the graph alone while graphLock is not -1");
  fixture->graph_header[NARSIL_GRAPH_WORD_LOCK] = NARSIL_GRAPH_HELD_ALONE;
  check(narsil_place(workspace, &fixture->graph, &fixture->store, &alone) == NARSIL_OK,
        "place links a node for the caller that holds the graph alone");
  check(fixture->graph_header[NARSIL_GRAPH_WORD_LOCK] == NARSIL_GRAPH_HELD_ALONE,
        "place leaves graphLock at -1 for the caller that holds the graph alone");
  release_fixture(fixture);
}

static void refuse_bad_writes(narsil_workspace *workspace) {
  test_fixture *fixture = build_fixture_without_a_graph(0);
  check(fixture != NULL, "the fixture has its memory");
  if (fixture == NULL) { return; }
  narsil_place_request request = {NARSIL_METRIC_EUCLIDEAN, -1, 0, WRITER_THREAD_SLOT, 0};
  check(narsil_place(workspace, &fixture->graph, &fixture->store, &request) == NARSIL_INVALID_ARGUMENT,
        "place refuses a negative ordinal");
  request.ordinal = 0;
  request.top_layer = NARSIL_MAX_PLACEMENT_LAYERS;
  check(narsil_place(workspace, &fixture->graph, &fixture->store, &request) == NARSIL_INVALID_ARGUMENT,
        "place refuses a top layer past the layers that the core holds room for");
  request.top_layer = 0;
  fixture->present[0] = 0;
  check(narsil_place(workspace, &fixture->graph, &fixture->store, &request) == NARSIL_INVALID_ARGUMENT,
        "place refuses an ordinal whose vector the store lacks");
  check(fixture->graph_header[NARSIL_GRAPH_WORD_NODE_COUNT] == 0, "a refused placement leaves nodeCount alone");
  check(remove_one(fixture, NODES) == NARSIL_INVALID_ARGUMENT, "remove refuses an ordinal at or above slots");
  check(isfinite(fixture->magnitudes[0]), "the fixture keeps its magnitudes");
  release_fixture(fixture);
}

typedef struct {
  int32_t ordinals[WAKES_KEPT];
  int count;
} recorded_wakes;

static void record_wake(void *context, int32_t ordinal) {
  recorded_wakes *wakes = context;
  if (wakes->count < WAKES_KEPT) { wakes->ordinals[wakes->count] = ordinal; }
  wakes->count += 1;
}

static void wake_a_sleeping_writer(narsil_workspace *workspace) {
  test_fixture *fixture = build_fixture_without_a_graph(0);
  check(fixture != NULL, "the fixture has its memory");
  if (fixture == NULL) { return; }
  recorded_wakes wakes = {{0}, 0};
  fixture->graph.wake = record_wake;
  fixture->graph.wake_context = &wakes;
  check(place_one(workspace, fixture, 0) == NARSIL_OK, "place returns NARSIL_OK beside a wake callback");
  check(wakes.count == 1 && wakes.ordinals[0] == NARSIL_WAKE_ENTRY_LOCK,
        "place names the entry lock to the wake callback once it stores the entry point");

  wakes.count = 0;
  fixture->locks[0] |= WRITER_WAITING_BIT;
  check(place_one(workspace, fixture, 1) == NARSIL_OK, "place links a node beside a sleeping writer");
  check(wakes.count == 1 && wakes.ordinals[0] == 0,
        "place names the ordinal whose lock word held writerWaiting to the wake callback");
  check((fixture->locks[0] & (WRITE_HELD_BIT | WRITER_WAITING_BIT)) == 0,
        "unlockNode clears writeHeld and writerWaiting");
  release_fixture(fixture);
}

void write_checks(narsil_workspace *workspace) {
  wake_a_sleeping_writer(workspace);
  build_a_graph_by_placement(workspace);
  ask_for_room(workspace);
  remove_then_compact(workspace);
  place_over_a_tombstone(workspace);
  refuse_bad_writes(workspace);
}
