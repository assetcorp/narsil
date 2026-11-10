#include "allocation_failures.h"
#include "fixture.h"

#include "../include/narsil_core.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define WRITER_THREAD_SLOT 3
#define SEARCH_THREAD_SLOT 1
#define QUERY_NODE 5
#define LAST_PLACED_NODE 384
#define REMOVED_STEP 5
#define REMOVAL_SEQUENCE 2
#define QUANTISED_BITS 4
#define EVERY_OTHER_ORDINAL 0x55U
#define ACCEPTED_BYTES (NODES / BITS_PER_BYTE)
#define MEASURE_TOTALS_PAST_DIMENSION 2
#define NEARBY_COUNT 4
#define LOCK_HELD_BITS 3U

typedef struct {
  test_fixture *fixture;
  int32_t ordinals[CANDIDATES];
  double distances[CANDIDATES];
  uint32_t count;
} graph_inputs;

static int32_t every_ordinal[NODES];
static uint8_t accepted_ordinals[ACCEPTED_BYTES];

static graph_inputs *holding(test_fixture *fixture) {
  if (fixture == NULL) { return NULL; }
  graph_inputs *inputs = calloc(1, sizeof *inputs);
  if (inputs == NULL) {
    release_fixture(fixture);
    return NULL;
  }
  inputs->fixture = fixture;
  return inputs;
}

static void release_graph(void *opaque) {
  graph_inputs *inputs = opaque;
  release_fixture(inputs->fixture);
  free(inputs);
}

static uint64_t digest_of_graph(const void *opaque) {
  const graph_inputs *inputs = opaque;
  const test_fixture *fixture = inputs->fixture;
  uint64_t digest = digest_bytes(DIGEST_START, fixture, offsetof(test_fixture, locks));
  for (size_t node = 0; node < NODES; node++) {
    digest = digest_word(digest, (uint32_t)fixture->locks[node] & LOCK_HELD_BITS);
  }
  const uint8_t *bytes = (const uint8_t *)fixture;
  digest = digest_bytes(digest, bytes + offsetof(test_fixture, tombstones),
                        offsetof(test_fixture, held_locks) - offsetof(test_fixture, tombstones));
  for (size_t word = 0; word < sizeof fixture->held_locks / sizeof fixture->held_locks[0]; word++) {
    if (word % NARSIL_HELD_WORDS_PER_THREAD != NARSIL_HELD_WORD_NODE_VALUE) {
      digest = digest_word(digest, (uint32_t)fixture->held_locks[word]);
    }
  }
  digest = digest_bytes(digest, bytes + offsetof(test_fixture, store_header),
                        offsetof(test_fixture, vectors) - offsetof(test_fixture, store_header));
  digest = digest_bytes(digest, fixture->records, (size_t)NODES * fixture_record_bytes(fixture->store.bits));
  digest = digest_word(digest, inputs->count);
  digest = digest_bytes(digest, inputs->ordinals, inputs->count * sizeof inputs->ordinals[0]);
  return digest_bytes(digest, inputs->distances, inputs->count * sizeof inputs->distances[0]);
}

static narsil_status place_node(narsil_workspace *workspace, test_fixture *fixture, int32_t ordinal) {
  narsil_place_request request = {NARSIL_METRIC_EUCLIDEAN, ordinal, fixture_top_layer(ordinal), WRITER_THREAD_SLOT, 0};
  return narsil_place(workspace, &fixture->graph, &fixture->store, &request);
}

static test_fixture *placed_graph(int32_t left_out) {
  restart_random();
  test_fixture *fixture = build_fixture_without_a_graph(0);
  narsil_workspace *workspace = NULL;
  if (fixture == NULL || narsil_workspace_create(&workspace) != NARSIL_OK) {
    if (fixture != NULL) { release_fixture(fixture); }
    return NULL;
  }
  narsil_status status = NARSIL_OK;
  for (int32_t node = 0; node < NODES && status == NARSIL_OK; node++) {
    if (node != left_out) { status = place_node(workspace, fixture, node); }
  }
  narsil_workspace_destroy(workspace);
  if (status != NARSIL_OK) {
    release_fixture(fixture);
    return NULL;
  }
  return fixture;
}

static test_fixture *graph_with_removals(void) {
  test_fixture *fixture = placed_graph(-1);
  if (fixture == NULL) { return NULL; }
  for (int32_t node = 0; node < NODES; node += REMOVED_STEP) {
    narsil_remove_request request = {node, WRITER_THREAD_SLOT};
    fixture->retired_at[node] = REMOVAL_SEQUENCE;
    if (narsil_remove(&fixture->graph, &request) != NARSIL_OK) {
      release_fixture(fixture);
      return NULL;
    }
  }
  fixture->graph_header[NARSIL_GRAPH_WORD_LOCK] = NARSIL_GRAPH_HELD_ALONE;
  return fixture;
}

static test_fixture *graph_without_one_node(void) { return placed_graph(LAST_PLACED_NODE); }

static test_fixture *compacted_graph(void) {
  test_fixture *fixture = graph_with_removals();
  narsil_workspace *workspace = NULL;
  if (fixture == NULL || narsil_workspace_create(&workspace) != NARSIL_OK) {
    if (fixture != NULL) { release_fixture(fixture); }
    return NULL;
  }
  narsil_compact_request request = {NARSIL_METRIC_EUCLIDEAN, WRITER_THREAD_SLOT};
  narsil_status status = narsil_compact(workspace, &fixture->graph, &fixture->store, &request);
  narsil_workspace_destroy(workspace);
  if (status != NARSIL_OK) {
    release_fixture(fixture);
    return NULL;
  }
  return fixture;
}

enum { GRAPH_WITHOUT_ONE_NODE, GRAPH_WITH_REMOVALS, COMPACTED_GRAPH, BUILT_GRAPHS };

static test_fixture *built_graphs[BUILT_GRAPHS];

static void *copy_of_built_graph(size_t graph, test_fixture *(*build)(void)) {
  if (built_graphs[graph] == NULL) { built_graphs[graph] = build(); }
  return holding(copy_fixture(built_graphs[graph]));
}

static void release_built_graphs(void) {
  for (size_t graph = 0; graph < BUILT_GRAPHS; graph++) {
    if (built_graphs[graph] != NULL) { release_fixture(built_graphs[graph]); }
    built_graphs[graph] = NULL;
  }
}

static void *prepare_linked_graph(void) {
  restart_random();
  return holding(build_fixture(0));
}

static void *prepare_quantised_graph(void) {
  restart_random();
  return holding(build_fixture(QUANTISED_BITS));
}

static void *prepare_graph_without_one_node(void) {
  return copy_of_built_graph(GRAPH_WITHOUT_ONE_NODE, graph_without_one_node);
}

static void *prepare_graph_with_removals(void) { return copy_of_built_graph(GRAPH_WITH_REMOVALS, graph_with_removals); }

static void *prepare_compacted_graph(void) { return copy_of_built_graph(COMPACTED_GRAPH, compacted_graph); }

static void *prepare_uncalibrated_records(void) {
  restart_random();
  test_fixture *fixture = build_fixture_without_a_graph(QUANTISED_BITS);
  if (fixture != NULL) { memset(fixture->centroid, 0, sizeof fixture->centroid); }
  return holding(fixture);
}

static void *prepare_calibrated_records(void) {
  graph_inputs *inputs = prepare_uncalibrated_records();
  narsil_workspace *workspace = NULL;
  if (inputs == NULL || narsil_workspace_create(&workspace) != NARSIL_OK) {
    if (inputs != NULL) { release_graph(inputs); }
    return NULL;
  }
  test_fixture *fixture = inputs->fixture;
  double totals[DIMENSION + MEASURE_TOTALS_PAST_DIMENSION] = {0};
  narsil_ordinals_request request = {NARSIL_METRIC_EUCLIDEAN, every_ordinal, NODES};
  narsil_status status = narsil_measure(workspace, &fixture->store, &request, totals);
  narsil_workspace_destroy(workspace);
  if (status != NARSIL_OK || totals[DIMENSION + 1] <= 0) {
    release_graph(inputs);
    return NULL;
  }
  for (uint32_t axis = 0; axis < DIMENSION; axis++) {
    fixture->centroid[axis] = (float)(totals[axis] / totals[DIMENSION + 1]);
  }
  fixture->store_header[NARSIL_STORE_WORD_CALIBRATION_GENERATION] += 1;
  fixture->store_header[NARSIL_STORE_WORD_CALIBRATED] = 1;
  return inputs;
}

static const float *query_vector(const test_fixture *fixture) {
  return fixture->vectors + ((size_t)QUERY_NODE * fixture_vector_stride_floats());
}

static narsil_status search_graph(narsil_workspace *workspace, graph_inputs *inputs, narsil_search_request request) {
  narsil_candidates found = {inputs->ordinals, inputs->distances, CANDIDATES, 0};
  narsil_status status = narsil_search(workspace, &inputs->fixture->graph, &inputs->fixture->store, &request, &found);
  inputs->count = status == NARSIL_OK ? found.count : 0;
  return status;
}

static narsil_status search_by_cosine(narsil_workspace *workspace, void *opaque) {
  graph_inputs *inputs = opaque;
  narsil_search_request request = {
      query_vector(inputs->fixture), NARSIL_METRIC_COSINE, CANDIDATES, SEARCH_THREAD_SLOT, {NULL, 0}, FIXTURE_PIN};
  return search_graph(workspace, inputs, request);
}

static narsil_status search_accepted_records(narsil_workspace *workspace, void *opaque) {
  graph_inputs *inputs = opaque;
  narsil_search_request request = {query_vector(inputs->fixture),
                                   NARSIL_METRIC_EUCLIDEAN,
                                   CANDIDATES,
                                   SEARCH_THREAD_SLOT,
                                   {accepted_ordinals, ACCEPTED_BYTES},
                                   FIXTURE_PIN};
  return search_graph(workspace, inputs, request);
}

static narsil_status score_vectors(narsil_workspace *workspace, void *opaque) {
  graph_inputs *inputs = opaque;
  narsil_score_request request = {query_vector(inputs->fixture), NARSIL_METRIC_DOT_PRODUCT, every_ordinal, CANDIDATES,
                                  FIXTURE_PIN};
  narsil_status status = narsil_score(workspace, &inputs->fixture->store, &request, inputs->distances);
  inputs->count = status == NARSIL_OK ? CANDIDATES : 0;
  return status;
}

static narsil_status place_last_node(narsil_workspace *workspace, void *opaque) {
  graph_inputs *inputs = opaque;
  return place_node(workspace, inputs->fixture, LAST_PLACED_NODE);
}

static narsil_status compact_graph(narsil_workspace *workspace, void *opaque) {
  graph_inputs *inputs = opaque;
  narsil_compact_request request = {NARSIL_METRIC_EUCLIDEAN, WRITER_THREAD_SLOT};
  return narsil_compact(workspace, &inputs->fixture->graph, &inputs->fixture->store, &request);
}

static narsil_status connect_unreached(narsil_workspace *workspace, void *opaque) {
  graph_inputs *inputs = opaque;
  static const int32_t nearby[NEARBY_COUNT] = {1, 2, 3, 4};
  narsil_connect_request request = {NARSIL_METRIC_EUCLIDEAN, WRITER_THREAD_SLOT, nearby, NEARBY_COUNT};
  return narsil_connect_unreached(workspace, &inputs->fixture->graph, &inputs->fixture->store, &request);
}

static narsil_status measure_records(narsil_workspace *workspace, void *opaque) {
  graph_inputs *inputs = opaque;
  double totals[DIMENSION + MEASURE_TOTALS_PAST_DIMENSION] = {0};
  narsil_ordinals_request request = {NARSIL_METRIC_EUCLIDEAN, every_ordinal, NODES};
  narsil_status status = narsil_measure(workspace, &inputs->fixture->store, &request, totals);
  inputs->count = status == NARSIL_OK ? CANDIDATES : 0;
  memcpy(inputs->distances, totals, sizeof inputs->distances);
  return status;
}

static narsil_status quantise_records(narsil_workspace *workspace, void *opaque) {
  graph_inputs *inputs = opaque;
  narsil_ordinals_request request = {NARSIL_METRIC_EUCLIDEAN, every_ordinal, NODES};
  return narsil_quantise(workspace, &inputs->fixture->store, &request);
}

void graph_allocation_failures(void) {
  for (int32_t node = 0; node < NODES; node++) { every_ordinal[node] = node; }
  memset(accepted_ordinals, EVERY_OTHER_ORDINAL, sizeof accepted_ordinals);
  const failing_call calls[] = {
      {"a cosine search", prepare_linked_graph, search_by_cosine, digest_of_graph, release_graph},
      {"a search of accepted records", prepare_quantised_graph, search_accepted_records, digest_of_graph,
       release_graph},
      {"a score of stored vectors", prepare_linked_graph, score_vectors, digest_of_graph, release_graph},
      {"a placement", prepare_graph_without_one_node, place_last_node, digest_of_graph, release_graph},
      {"a compaction", prepare_graph_with_removals, compact_graph, digest_of_graph, release_graph},
      {"a connection of unreached nodes", prepare_compacted_graph, connect_unreached, digest_of_graph, release_graph},
      {"a measure of records", prepare_uncalibrated_records, measure_records, digest_of_graph, release_graph},
      {"a quantisation", prepare_calibrated_records, quantise_records, digest_of_graph, release_graph},
  };
  for (size_t at = 0; at < sizeof calls / sizeof calls[0]; at++) { refuse_each_allocation(&calls[at]); }
  release_built_graphs();
}
