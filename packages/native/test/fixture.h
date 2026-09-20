#ifndef NARSIL_TEST_FIXTURE_H
#define NARSIL_TEST_FIXTURE_H

#include "../include/narsil_core.h"

#include <stdint.h>

#define NODES 400
#define DIMENSION 53
#define MAX_NEIGHBOURS 4
#define MAX_BASE_NEIGHBOURS 8
#define THREAD_SLOTS 4
#define CANDIDATES 32
#define BITS_PER_BYTE 8
#define UPPER_LAYER_SPACING 16
#define NEIGHBOUR_STEP 7

typedef struct {
  int32_t graph_header[NARSIL_GRAPH_HEADER_WORDS];
  uint8_t node_levels[NODES];
  int32_t level0[NODES * (MAX_BASE_NEIGHBOURS + NARSIL_LIST_WORDS_OVER_NEIGHBOURS)];
  int32_t upper_base[NODES];
  int32_t upper[NODES * (MAX_NEIGHBOURS + NARSIL_LIST_WORDS_OVER_NEIGHBOURS)];
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

void report(const char *line);
void check(int condition, const char *what);
int failed_checks(void);
float random_unit(void);
test_fixture *build_fixture(uint32_t bits);
void release_fixture(test_fixture *fixture);
void concurrent_checks(void);

#endif
