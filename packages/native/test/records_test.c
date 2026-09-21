#include "fixture.h"

#include "../include/narsil_core.h"

#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#define WRITER_THREAD_SLOT 3
#define TRAILER_LOWER_OFFSET 0
#define TRAILER_UPPER_OFFSET 4
#define TRAILER_SUM_OFFSET 12
#define CENTROID_TOLERANCE 1e-5
#define EIGHT_BIT_MEAN_ERROR_CEILING 0.02
#define NEAREST_IS_ITSELF_FLOOR ((NODES * 8) / 10)

static int32_t every_ordinal[NODES];

static void list_every_ordinal(void) {
  for (int32_t node = 0; node < NODES; node++) { every_ordinal[node] = node; }
}

static uint32_t level_at(const uint8_t *record, uint32_t bits, uint32_t position) {
  uint32_t per_byte = BITS_PER_BYTE / bits;
  uint32_t mask = (1U << bits) - 1;
  return ((uint32_t)record[position / per_byte] >> ((position % per_byte) * bits)) & mask;
}

static float trailer_float(const uint8_t *trailer, size_t offset) {
  float value = 0;
  memcpy(&value, trailer + offset, sizeof value);
  return value;
}

static double mean_reconstruction_error(const test_fixture *fixture, uint32_t bits, int32_t node) {
  uint32_t code_bytes = fixture_record_bytes(bits) - NARSIL_OSQ_TRAILER_BYTES;
  const uint8_t *record = fixture->records + ((size_t)node * fixture_record_bytes(bits));
  const float *vector = fixture->vectors + ((size_t)node * fixture_vector_stride_floats());
  double lower = (double)trailer_float(record + code_bytes, TRAILER_LOWER_OFFSET);
  double upper = (double)trailer_float(record + code_bytes, TRAILER_UPPER_OFFSET);
  double step = (upper - lower) / (double)((1U << bits) - 1);
  double error = 0;
  for (uint32_t axis = 0; axis < DIMENSION; axis++) {
    double rebuilt = (double)fixture->centroid[axis] + lower + (step * (double)level_at(record, bits, axis));
    error += fabs((double)vector[axis] - rebuilt);
  }
  return error / DIMENSION;
}

static void check_one_record(const test_fixture *fixture, uint32_t bits, int32_t node) {
  uint32_t code_bytes = fixture_record_bytes(bits) - NARSIL_OSQ_TRAILER_BYTES;
  const uint8_t *record = fixture->records + ((size_t)node * fixture_record_bytes(bits));
  uint32_t stored_sum = 0;
  memcpy(&stored_sum, record + code_bytes + TRAILER_SUM_OFFSET, sizeof stored_sum);
  uint32_t sum = 0;
  for (uint32_t axis = 0; axis < DIMENSION; axis++) { sum += level_at(record, bits, axis); }
  check(sum == stored_sum, "a record's trailer holds the sum of its levels");
  check(trailer_float(record + code_bytes, TRAILER_LOWER_OFFSET) <=
            trailer_float(record + code_bytes, TRAILER_UPPER_OFFSET),
        "a record's lower bound is at or below its upper bound");
  if (bits == BITS_PER_BYTE) {
    check(mean_reconstruction_error(fixture, bits, node) < EIGHT_BIT_MEAN_ERROR_CEILING,
          "an 8-bit record rebuilds its vector closely");
  }
}

static void check_the_centroid(const test_fixture *fixture) {
  for (uint32_t axis = 0; axis < DIMENSION; axis++) {
    double mean = 0;
    for (int32_t node = 0; node < NODES; node++) {
      mean += (double)fixture->vectors[((size_t)node * fixture_vector_stride_floats()) + axis];
    }
    mean /= NODES;
    check(fabs(mean - (double)fixture->centroid[axis]) < CENTROID_TOLERANCE,
          "calibrate stores the mean of the vectors");
  }
}

static int nearest_is_itself(narsil_workspace *workspace, test_fixture *fixture, int32_t node) {
  int32_t ordinals[CANDIDATES];
  double distances[CANDIDATES];
  narsil_candidates found = {ordinals, distances, CANDIDATES, 0};
  const float *query = fixture->vectors + ((size_t)node * fixture_vector_stride_floats());
  narsil_search_request request = {query, NARSIL_METRIC_EUCLIDEAN, CANDIDATES, 0};
  if (narsil_search(workspace, &fixture->graph, &fixture->store, &request, &found) != NARSIL_OK) { return 0; }
  for (uint32_t i = 0; i < found.count && i < 3; i++) {
    if (found.ordinals[i] == node) { return 1; }
  }
  return 0;
}

static void build_a_graph_from_codes(narsil_workspace *workspace, test_fixture *fixture) {
  for (int32_t node = 0; node < NODES; node++) {
    narsil_place_request request = {NARSIL_METRIC_EUCLIDEAN, node, fixture_top_layer(node), WRITER_THREAD_SLOT, 0};
    check(narsil_place(workspace, &fixture->graph, &fixture->store, &request) == NARSIL_OK,
          "place returns NARSIL_OK over a store with codes");
  }
  int found_itself = 0;
  for (int32_t node = 0; node < NODES; node++) { found_itself += nearest_is_itself(workspace, fixture, node); }
  check(found_itself >= NEAREST_IS_ITSELF_FLOOR,
        "a graph that the core builds from 8-bit codes finds most vectors among their three nearest");
}

static void write_records_of_one_width(narsil_workspace *workspace, uint32_t bits) {
  test_fixture *fixture = build_fixture_without_a_graph(bits);
  check(fixture != NULL, "the fixture has its memory");
  if (fixture == NULL) { return; }
  memset(fixture->centroid, 0, sizeof fixture->centroid);
  narsil_ordinals_request request = {NARSIL_METRIC_EUCLIDEAN, every_ordinal, NODES};
  check(narsil_quantise(workspace, &fixture->store, &request) == NARSIL_INVALID_ARGUMENT,
        "quantise refuses a store that holds no calibration");
  check(narsil_calibrate(workspace, &fixture->store, &request) == NARSIL_OK, "calibrate returns NARSIL_OK");
  check(fixture->store_header[NARSIL_STORE_WORD_CALIBRATED] == 1, "calibrate stores 1 in calibrated");
  check(fixture->store_header[NARSIL_STORE_WORD_CALIBRATION_GENERATION] == 1,
        "calibrate raises calibrationGeneration by 1");
  check_the_centroid(fixture);

  check(narsil_quantise(workspace, &fixture->store, &request) == NARSIL_OK, "quantise returns NARSIL_OK");
  check(narsil_quantise(workspace, &fixture->store, &request) == NARSIL_OK, "quantise rewrites a record");
  check(fixture->store_header[NARSIL_STORE_WORD_CODE_COUNT] == NODES, "quantise raises codeCount once for an ordinal");
  for (int32_t node = 0; node < NODES; node++) {
    check(fixture->code_present[node] == 1, "quantise stores 1 in codePresent");
    check_one_record(fixture, bits, node);
  }
  if (bits == BITS_PER_BYTE) { build_a_graph_from_codes(workspace, fixture); }
  release_fixture(fixture);
}

static void refuse_a_store_without_codes(narsil_workspace *workspace) {
  test_fixture *fixture = build_fixture_without_a_graph(0);
  check(fixture != NULL, "the fixture has its memory");
  if (fixture == NULL) { return; }
  narsil_ordinals_request request = {NARSIL_METRIC_COSINE, every_ordinal, NODES};
  check(narsil_calibrate(workspace, &fixture->store, &request) == NARSIL_INVALID_ARGUMENT,
        "calibrate refuses a store that keeps no codes");
  release_fixture(fixture);
}

void record_checks(narsil_workspace *workspace) {
  const uint32_t widths[] = {1, 2, 4, BITS_PER_BYTE};
  list_every_ordinal();
  for (size_t width = 0; width < sizeof widths / sizeof widths[0]; width++) {
    write_records_of_one_width(workspace, widths[width]);
  }
  refuse_a_store_without_codes(workspace);
}
