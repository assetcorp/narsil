#include "../include/narsil_core.h"

#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define NODES 400
#define DIMENSION 53
#define MAX_NEIGHBOURS 4
#define MAX_BASE_NEIGHBOURS 8
#define LIST_STRIDE_OVER_MAX_NEIGHBOURS 2
#define THREAD_SLOTS 4
#define CANDIDATES 32
#define BITS_PER_BYTE 8
#define VECTOR_ALIGNMENT_BYTES 16
#define UPPER_LAYER_SPACING 16
#define NEIGHBOUR_STEP 7
#define METRIC_COUNT 3
#define UNKNOWN_METRIC 9
#define SEARCH_THREAD_SLOT 1
#define PLACE_THREAD_SLOT 2
#define PLACED_ORDINAL 5

#define RANDOM_SEED 20260918U
#define RANDOM_MULTIPLIER 1664525U
#define RANDOM_INCREMENT 1013904223U
#define RANDOM_DISCARDED_BITS 8
#define RANDOM_KEPT_BITS 24

#define TRAILER_LOWER_OFFSET 0
#define TRAILER_UPPER_OFFSET 4
#define TRAILER_CORRECTION_OFFSET 8
#define TRAILER_SUM_OFFSET 12
#define FIXTURE_LOWER (-0.5F)
#define FIXTURE_UPPER 0.5F
#define FIXTURE_CORRECTION 0.01F
#define FIXTURE_LEVEL_SUM 100U
#define CENTROID_STEP 0.01F

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

static int failures = 0;

static void report(const char *line) {
  if (fputs(line, stderr) == EOF || fputc('\n', stderr) == EOF) { failures += 1; }
}

static void check(int condition, const char *what) {
  if (condition) { return; }
  failures += 1;
  report(what);
}

static uint32_t random_state = RANDOM_SEED;

static uint32_t next_random(void) {
  random_state = (random_state * RANDOM_MULTIPLIER) + RANDOM_INCREMENT;
  return random_state;
}

static float random_unit(void) {
  return (float)(next_random() >> RANDOM_DISCARDED_BITS) / (float)(1U << RANDOM_KEPT_BITS);
}

typedef struct {
  int32_t graph_header[NARSIL_GRAPH_HEADER_WORDS];
  uint8_t node_levels[NODES];
  int32_t level0[NODES * (MAX_BASE_NEIGHBOURS + LIST_STRIDE_OVER_MAX_NEIGHBOURS)];
  int32_t upper_base[NODES];
  int32_t upper[NODES * (MAX_NEIGHBOURS + LIST_STRIDE_OVER_MAX_NEIGHBOURS)];
  int32_t locks[NODES];
  uint8_t tombstones[NODES];
  int32_t held_locks[THREAD_SLOTS * NARSIL_HELD_WORDS_PER_THREAD];
  int32_t store_header[NARSIL_STORE_HEADER_WORDS];
  uint8_t code_present[NODES];
  uint8_t present[NODES];
  float centroid[DIMENSION];
  double magnitudes[NODES];
  float *vectors;
  uint8_t *records;
  const float *vector_blocks[1];
  const uint8_t *code_blocks[1];
  narsil_graph graph;
  narsil_store store;
} test_fixture;

static uint32_t vector_stride_floats(void) {
  uint32_t bytes = DIMENSION * (uint32_t)sizeof(float);
  uint32_t aligned = ((bytes + VECTOR_ALIGNMENT_BYTES - 1) / VECTOR_ALIGNMENT_BYTES) * VECTOR_ALIGNMENT_BYTES;
  return aligned / (uint32_t)sizeof(float);
}

static void write_record(uint8_t *record, uint32_t code_bytes) {
  for (uint32_t i = 0; i < code_bytes; i++) { record[i] = (uint8_t)next_random(); }
  float lower = FIXTURE_LOWER;
  float upper = FIXTURE_UPPER;
  float correction = FIXTURE_CORRECTION;
  uint32_t sum = FIXTURE_LEVEL_SUM;
  memcpy(record + code_bytes + TRAILER_LOWER_OFFSET, &lower, sizeof lower);
  memcpy(record + code_bytes + TRAILER_UPPER_OFFSET, &upper, sizeof upper);
  memcpy(record + code_bytes + TRAILER_CORRECTION_OFFSET, &correction, sizeof correction);
  memcpy(record + code_bytes + TRAILER_SUM_OFFSET, &sum, sizeof sum);
}

static uint32_t record_bytes_of(uint32_t bits) {
  if (bits == 0) { return 0; }
  return (((DIMENSION * bits) + BITS_PER_BYTE - 1) / BITS_PER_BYTE) + NARSIL_OSQ_TRAILER_BYTES;
}

static void write_nodes(test_fixture *fixture, uint32_t bits) {
  uint32_t stride = vector_stride_floats();
  uint32_t record_bytes = record_bytes_of(bits);
  for (int32_t node = 0; node < NODES; node++) {
    float *vector = fixture->vectors + ((size_t)node * stride);
    double squares = 0;
    for (int i = 0; i < DIMENSION; i++) {
      vector[i] = (random_unit() * 2) - 1;
      squares += (double)vector[i] * (double)vector[i];
    }
    fixture->magnitudes[node] = sqrt(squares);
    fixture->present[node] = 1;
    fixture->code_present[node] = bits != 0 ? 1 : 0;
    if (bits != 0) {
      write_record(fixture->records + ((size_t)node * record_bytes), record_bytes - NARSIL_OSQ_TRAILER_BYTES);
    }
    fixture->node_levels[node] = node % UPPER_LAYER_SPACING == 0 ? 2 : 1;
    int32_t *list = fixture->level0 + ((size_t)node * (MAX_BASE_NEIGHBOURS + LIST_STRIDE_OVER_MAX_NEIGHBOURS));
    list[0] = MAX_BASE_NEIGHBOURS;
    for (int32_t i = 0; i < MAX_BASE_NEIGHBOURS; i++) { list[i + 1] = (node + ((i + 1) * NEIGHBOUR_STEP)) % NODES; }
  }
}

static int32_t write_upper_layer(test_fixture *fixture) {
  int32_t upper_used = 0;
  for (int32_t node = 0; node < NODES; node += UPPER_LAYER_SPACING) {
    fixture->upper_base[node] = upper_used + 1;
    int32_t *list = fixture->upper + upper_used;
    list[0] = MAX_NEIGHBOURS;
    for (int32_t i = 0; i < MAX_NEIGHBOURS; i++) {
      list[i + 1] = (((node / UPPER_LAYER_SPACING) + i + 1) * UPPER_LAYER_SPACING) % NODES;
    }
    upper_used += MAX_NEIGHBOURS + LIST_STRIDE_OVER_MAX_NEIGHBOURS;
  }
  return upper_used;
}

static test_fixture *build_fixture(uint32_t bits) {
  test_fixture *fixture = calloc(1, sizeof *fixture);
  if (fixture == NULL) { return NULL; }
  uint32_t stride = vector_stride_floats();
  uint32_t record_bytes = record_bytes_of(bits);
  fixture->vectors = calloc((size_t)NODES * stride, sizeof(float));
  fixture->records = calloc(NODES, record_bytes == 0 ? 1 : record_bytes);
  if (fixture->vectors == NULL || fixture->records == NULL) {
    free(fixture->vectors);
    free(fixture->records);
    free(fixture);
    return NULL;
  }
  write_nodes(fixture, bits);
  int32_t upper_used = write_upper_layer(fixture);
  for (int i = 0; i < DIMENSION; i++) { fixture->centroid[i] = CENTROID_STEP * (float)i; }

  fixture->graph_header[NARSIL_GRAPH_WORD_ENTRY_POINT] = 0;
  fixture->graph_header[NARSIL_GRAPH_WORD_TOP_LAYER] = 1;
  fixture->graph_header[NARSIL_GRAPH_WORD_M] = MAX_NEIGHBOURS;
  fixture->graph_header[NARSIL_GRAPH_WORD_MMAX0] = MAX_BASE_NEIGHBOURS;
  fixture->graph_header[NARSIL_GRAPH_WORD_EF_CONSTRUCTION] = CANDIDATES;
  fixture->graph_header[NARSIL_GRAPH_WORD_NODE_COUNT] = NODES;
  fixture->graph_header[NARSIL_GRAPH_WORD_UPPER_USED] = upper_used;
  fixture->graph_header[NARSIL_GRAPH_WORD_SLOTS] = NODES;
  fixture->store_header[NARSIL_STORE_WORD_SLOTS] = NODES;
  fixture->store_header[NARSIL_STORE_WORD_LIVE_COUNT] = NODES;
  fixture->store_header[NARSIL_STORE_WORD_CALIBRATED] = bits != 0;
  fixture->store_header[NARSIL_STORE_WORD_CODE_COUNT] = bits != 0 ? NODES : 0;

  fixture->vector_blocks[0] = fixture->vectors;
  fixture->code_blocks[0] = fixture->records;
  fixture->graph = (narsil_graph){.header = fixture->graph_header,
                                  .node_levels = fixture->node_levels,
                                  .level0 = fixture->level0,
                                  .upper_base = fixture->upper_base,
                                  .upper = fixture->upper,
                                  .locks = fixture->locks,
                                  .tombstones = fixture->tombstones,
                                  .held_locks = fixture->held_locks,
                                  .thread_slots = THREAD_SLOTS};
  fixture->store = (narsil_store){.header = fixture->store_header,
                                  .dimension = DIMENSION,
                                  .bits = bits,
                                  .code_blocks = fixture->code_blocks,
                                  .code_block_count = bits != 0 ? 1U : 0U,
                                  .records_per_block = NODES,
                                  .code_present = fixture->code_present,
                                  .centroid = fixture->centroid,
                                  .vector_blocks = fixture->vector_blocks,
                                  .vector_block_count = 1,
                                  .vectors_per_block = NODES,
                                  .vector_stride_floats = stride,
                                  .magnitudes = fixture->magnitudes,
                                  .present = fixture->present};
  return fixture;
}

static void release_fixture(test_fixture *fixture) {
  free(fixture->vectors);
  free(fixture->records);
  free(fixture);
}

static void check_sorted(const narsil_candidates *found, const char *what) {
  for (uint32_t i = 1; i < found->count; i++) { check(found->distances[i - 1] <= found->distances[i], what); }
  for (uint32_t i = 0; i < found->count; i++) {
    check(found->ordinals[i] >= 0 && found->ordinals[i] < NODES, "a result names an ordinal inside the graph");
  }
}

static void search_one_width(narsil_workspace *workspace, uint32_t bits, const float *query) {
  test_fixture *fixture = build_fixture(bits);
  check(fixture != NULL, "the fixture allocates");
  if (fixture == NULL) { return; }
  int32_t ordinals[CANDIDATES];
  double distances[CANDIDATES];
  for (uint32_t metric = 0; metric < METRIC_COUNT; metric++) {
    narsil_candidates found = {ordinals, distances, CANDIDATES, 0};
    narsil_search_request request = {query, metric, CANDIDATES, SEARCH_THREAD_SLOT};
    check(narsil_search(workspace, &fixture->graph, &fixture->store, &request, &found) == NARSIL_OK, "search succeeds");
    check(found.count == CANDIDATES, "search fills the candidate count");
    check_sorted(&found, "search returns the nearest first");
    check(fixture->graph_header[NARSIL_GRAPH_WORD_LOCK] == 0, "search leaves the graph lock free");
    check(fixture->held_locks[(SEARCH_THREAD_SLOT * NARSIL_HELD_WORDS_PER_THREAD) + NARSIL_HELD_WORD_GRAPH] == 0,
          "search clears its held-lock record");

    double rescored[CANDIDATES];
    check(narsil_rescore(&fixture->store, query, metric, ordinals, found.count, rescored) == NARSIL_OK,
          "rescore succeeds");
    for (uint32_t i = 0; i < found.count; i++) { check(isfinite(rescored[i]), "rescore measures a stored vector"); }
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
    int32_t *list = fixture->level0 + ((size_t)node * (MAX_BASE_NEIGHBOURS + LIST_STRIDE_OVER_MAX_NEIGHBOURS));
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
  check(fixture != NULL, "the fixture allocates");
  if (fixture == NULL) { return; }
  corrupt_lists(fixture);

  int32_t ordinals[CANDIDATES];
  double distances[CANDIDATES];
  float query[DIMENSION];
  for (int i = 0; i < DIMENSION; i++) { query[i] = random_unit(); }
  narsil_candidates found = {ordinals, distances, CANDIDATES, 0};
  narsil_search_request request = {query, NARSIL_METRIC_COSINE, CANDIDATES, 0};
  check(narsil_search(workspace, &fixture->graph, &fixture->store, &request, &found) == NARSIL_OK,
        "search survives corrupt lists");
  check_sorted(&found, "search over corrupt lists returns ordinals inside the graph");
  for (uint32_t i = 0; i < found.count; i++) {
    check(found.ordinals[i] != TOMBSTONED_ORDINAL, "search skips a tombstone");
    check(found.ordinals[i] != UNRECORDED_ORDINAL, "search skips an ordinal with no record");
  }

  int32_t unsorted[3] = {-1, RESCORED_ORDINAL_PAST_THE_STORE, RESCORED_ORDINAL};
  double rescored[3];
  check(narsil_rescore(&fixture->store, query, NARSIL_METRIC_EUCLIDEAN, unsorted, 3, rescored) == NARSIL_OK,
        "rescore runs");
  check(isinf(rescored[0]) && isinf(rescored[1]) && isfinite(rescored[2]),
        "rescore refuses ordinals outside the store");
  release_fixture(fixture);
}

static void place_a_vector(narsil_workspace *workspace) {
  test_fixture *fixture = build_fixture(0);
  check(fixture != NULL, "the fixture allocates");
  if (fixture == NULL) { return; }
  int32_t ordinals[2 * CANDIDATES];
  double distances[2 * CANDIDATES];
  narsil_candidates layers[2] = {{ordinals, distances, CANDIDATES, 0},
                                 {ordinals + CANDIDATES, distances + CANDIDATES, CANDIDATES, 0}};
  narsil_place_request request = {fixture->vector_blocks[0], NARSIL_METRIC_COSINE, PLACED_ORDINAL, 1,
                                  PLACE_THREAD_SLOT};
  narsil_placement placement = {layers, 2, -2};
  check(narsil_place(workspace, &fixture->graph, &fixture->store, &request, &placement) == NARSIL_OK, "place succeeds");
  check(placement.linked_top_layer == 1, "place links up to the graph's top layer");
  check(layers[0].count == CANDIDATES, "place fills the base layer's candidates");
  check(layers[1].count > 0, "place finds candidates on the upper layer");
  check_sorted(&layers[0], "place returns the nearest first");
  release_fixture(fixture);
}

static void refuse_bad_arguments(narsil_workspace *workspace) {
  test_fixture *fixture = build_fixture(4);
  check(fixture != NULL, "the fixture allocates");
  if (fixture == NULL) { return; }
  int32_t ordinals[CANDIDATES] = {0};
  double distances[CANDIDATES] = {0};
  float query[DIMENSION] = {0};
  narsil_candidates found = {ordinals, distances, 4, 0};
  narsil_search_request request = {query, NARSIL_METRIC_COSINE, CANDIDATES, 0};
  check(narsil_search(workspace, &fixture->graph, &fixture->store, &request, &found) == NARSIL_INVALID_ARGUMENT,
        "search refuses a result list shorter than the candidate count");
  check(fixture->graph_header[NARSIL_GRAPH_WORD_LOCK] == 0, "a refused search leaves the graph lock free");
  found.capacity = CANDIDATES;
  request.thread_slot = THREAD_SLOTS;
  check(narsil_search(workspace, &fixture->graph, &fixture->store, &request, &found) == NARSIL_INVALID_ARGUMENT,
        "search refuses a thread slot outside heldLocks");
  request.thread_slot = 0;
  request.metric = UNKNOWN_METRIC;
  check(narsil_search(workspace, &fixture->graph, &fixture->store, &request, &found) == NARSIL_INVALID_ARGUMENT,
        "search refuses an unknown metric");
  double rescored[1];
  check(narsil_rescore(&fixture->store, query, UNKNOWN_METRIC, ordinals, 1, rescored) == NARSIL_INVALID_ARGUMENT,
        "rescore refuses an unknown metric");
  check(narsil_search(workspace, &fixture->graph, &fixture->store, NULL, &found) == NARSIL_INVALID_ARGUMENT,
        "search refuses a missing request");
  release_fixture(fixture);
}

int main(void) {
  narsil_workspace *workspace = NULL;
  check(narsil_workspace_create(&workspace) == NARSIL_OK, "the workspace opens");
  check(narsil_core_abi_version() == NARSIL_CORE_ABI_VERSION, "the binary reports the header's version");
  search_every_width(workspace);
  survive_corrupt_lists(workspace);
  place_a_vector(workspace);
  refuse_bad_arguments(workspace);
  narsil_workspace_destroy(workspace);
  if (failures > 0) {
    report("some checks failed");
    return 1;
  }
  if (puts("every check passed") == EOF) { return 1; }
  return 0;
}
