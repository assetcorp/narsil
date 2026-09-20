#include "fixture.h"

#include "../include/narsil_core.h"

#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define VECTOR_ALIGNMENT_BYTES 16
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

static int failures = 0;

void report(const char *line) {
  if (fputs(line, stderr) == EOF || fputc('\n', stderr) == EOF) { failures += 1; }
}

void check(int condition, const char *what) {
  if (condition) { return; }
  failures += 1;
  report(what);
}

int failed_checks(void) { return failures; }

static uint32_t random_state = RANDOM_SEED;

static uint32_t next_random(void) {
  random_state = (random_state * RANDOM_MULTIPLIER) + RANDOM_INCREMENT;
  return random_state;
}

float random_unit(void) { return (float)(next_random() >> RANDOM_DISCARDED_BITS) / (float)(1U << RANDOM_KEPT_BITS); }

uint32_t fixture_vector_stride_floats(void) {
  uint32_t bytes = DIMENSION * (uint32_t)sizeof(float);
  uint32_t aligned = ((bytes + VECTOR_ALIGNMENT_BYTES - 1) / VECTOR_ALIGNMENT_BYTES) * VECTOR_ALIGNMENT_BYTES;
  return aligned / (uint32_t)sizeof(float);
}

int32_t fixture_top_layer(int32_t node) { return node % UPPER_LAYER_SPACING == 0 ? 1 : 0; }

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

uint32_t fixture_record_bytes(uint32_t bits) {
  if (bits == 0) { return 0; }
  return (((DIMENSION * bits) + BITS_PER_BYTE - 1) / BITS_PER_BYTE) + NARSIL_OSQ_TRAILER_BYTES;
}

static void write_nodes(test_fixture *fixture, uint32_t bits) {
  uint32_t stride = fixture_vector_stride_floats();
  uint32_t record_bytes = fixture_record_bytes(bits);
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
    fixture->vector_file[node] = NARSIL_VECTOR_IN_A_BLOCK;
    fixture->node_levels[node] = (uint8_t)(fixture_top_layer(node) + 1);
    int32_t *list = fixture->level0 + ((size_t)node * BASE_LIST_WORDS);
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
    upper_used += UPPER_LIST_WORDS;
  }
  return upper_used;
}

static void forget_the_graph(test_fixture *fixture) {
  memset(fixture->node_levels, 0, sizeof fixture->node_levels);
  memset(fixture->level0, 0, sizeof fixture->level0);
  memset(fixture->upper_base, 0, sizeof fixture->upper_base);
  memset(fixture->upper, 0, sizeof fixture->upper);
  memset(fixture->code_present, 0, sizeof fixture->code_present);
  fixture->graph_header[NARSIL_GRAPH_WORD_ENTRY_POINT] = -1;
  fixture->graph_header[NARSIL_GRAPH_WORD_TOP_LAYER] = -1;
  fixture->graph_header[NARSIL_GRAPH_WORD_NODE_COUNT] = 0;
  fixture->graph_header[NARSIL_GRAPH_WORD_UPPER_USED] = 0;
  fixture->graph_header[NARSIL_GRAPH_WORD_SLOTS] = 0;
  fixture->store_header[NARSIL_STORE_WORD_CALIBRATED] = 0;
  fixture->store_header[NARSIL_STORE_WORD_CODE_COUNT] = 0;
}

test_fixture *build_fixture_without_a_graph(uint32_t bits) {
  test_fixture *fixture = build_fixture(bits);
  if (fixture != NULL) { forget_the_graph(fixture); }
  return fixture;
}

test_fixture *build_fixture(uint32_t bits) {
  test_fixture *fixture = calloc(1, sizeof *fixture);
  if (fixture == NULL) { return NULL; }
  uint32_t stride = fixture_vector_stride_floats();
  uint32_t record_bytes = fixture_record_bytes(bits);
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
  fixture->graph_header[NARSIL_GRAPH_WORD_SLOT_CAPACITY] = NODES;
  fixture->graph_header[NARSIL_GRAPH_WORD_UPPER_CAPACITY] = UPPER_WORDS;
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
                                  .present = fixture->present,
                                  .vector_file = fixture->vector_file,
                                  .vector_offset = fixture->vector_offset,
                                  .files = NULL,
                                  .file_count = 0};
  return fixture;
}

void release_fixture(test_fixture *fixture) {
  free(fixture->vectors);
  free(fixture->records);
  free(fixture);
}
