#include "fixture.h"

#include "../include/narsil_core.h"

#ifndef _WIN32

#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

#define WRITER_THREAD_SLOT 3
#define UNALIGNED_PADDING_BYTES 3
#define VECTOR_BYTES ((uint32_t)(DIMENSION * sizeof(float)))
#define ORDINAL_PAST_THE_FILE 9
#define SCORED 64
#define FILE_THE_CORE_LACKS 3

static int write_vector_file(const test_fixture *fixture, char *path) {
  int descriptor = mkstemp(path);
  if (descriptor < 0) { return 0; }
  FILE *file = fdopen(descriptor, "wb");
  if (file == NULL) {
    (void)close(descriptor);
    return 0;
  }
  const char padding[UNALIGNED_PADDING_BYTES] = {0};
  int written = fwrite(padding, 1, sizeof padding, file) == sizeof padding;
  for (int32_t node = 0; node < NODES && written; node++) {
    const float *vector = fixture->vectors + ((size_t)node * fixture_vector_stride_floats());
    written = fwrite(vector, sizeof(float), DIMENSION, file) == DIMENSION;
  }
  return fclose(file) == 0 && written;
}

static void read_every_vector_from(test_fixture *fixture, const narsil_vector_file *file) {
  for (int32_t node = 0; node < NODES; node++) {
    fixture->vector_file[node] = 0;
    fixture->vector_offset[node] = UNALIGNED_PADDING_BYTES + ((uint32_t)node * VECTOR_BYTES);
  }
  fixture->vector_blocks[0] = NULL;
  fixture->store.files = file;
  fixture->store.file_count = 1;
}

static void score_from_a_file(narsil_workspace *workspace, test_fixture *fixture, const narsil_vector_file *file) {
  int32_t ordinals[SCORED];
  double from_blocks[SCORED];
  double from_the_file[SCORED];
  float query[DIMENSION];
  for (int i = 0; i < DIMENSION; i++) { query[i] = (random_unit() * 2) - 1; }
  for (int32_t i = 0; i < SCORED; i++) { ordinals[i] = i; }
  narsil_score_request request = {query, NARSIL_METRIC_COSINE, ordinals, SCORED};
  check(narsil_score(workspace, &fixture->store, &request, from_blocks) == NARSIL_OK, "score reads the blocks");

  double in_a_file_the_core_lacks[SCORED];
  fixture->vector_file[0] = FILE_THE_CORE_LACKS;
  check(narsil_score(workspace, &fixture->store, &request, in_a_file_the_core_lacks) == NARSIL_OK &&
            isinf(in_a_file_the_core_lacks[0]) && in_a_file_the_core_lacks[1] == from_blocks[1],
        "score gives infinity for a vector in a file that the core lacks, although a block holds that vector");

  read_every_vector_from(fixture, file);
  fixture->vector_offset[ORDINAL_PAST_THE_FILE] = (uint32_t)file->length - 1;
  check(narsil_score(workspace, &fixture->store, &request, from_the_file) == NARSIL_OK, "score reads the file");
  for (int32_t i = 0; i < SCORED; i++) {
    if (i == ORDINAL_PAST_THE_FILE) {
      check(isinf(from_the_file[i]), "score gives infinity for a vector that ends beyond its file");
      continue;
    }
    check(from_the_file[i] == from_blocks[i], "a vector in a file scores the same as that vector in a block");
  }
  fixture->vector_offset[ORDINAL_PAST_THE_FILE] = UNALIGNED_PADDING_BYTES + (ORDINAL_PAST_THE_FILE * VECTOR_BYTES);
}

static void place_from_a_file(narsil_workspace *workspace, test_fixture *fixture) {
  for (int32_t node = 0; node < NODES; node++) {
    narsil_place_request request = {NARSIL_METRIC_COSINE, node, fixture_top_layer(node), WRITER_THREAD_SLOT, 0};
    check(narsil_place(workspace, &fixture->graph, &fixture->store, &request) == NARSIL_OK,
          "place reads the vector of its ordinal from a file");
  }
  int32_t ordinals[CANDIDATES];
  double distances[CANDIDATES];
  narsil_candidates found = {ordinals, distances, CANDIDATES, 0};
  narsil_search_request request = {fixture->vectors, NARSIL_METRIC_COSINE, CANDIDATES, 0};
  check(narsil_search(workspace, &fixture->graph, &fixture->store, &request, &found) == NARSIL_OK,
        "search walks a graph whose vectors a file holds");
  check(found.count == CANDIDATES && found.ordinals[0] == 0, "that search finds the vector it asks for");
}

void vector_file_checks(narsil_workspace *workspace) {
  test_fixture *fixture = build_fixture_without_a_graph(0);
  check(fixture != NULL, "the fixture has its memory");
  if (fixture == NULL) { return; }
  char path[] = "/tmp/narsil-core-vectors-XXXXXX";
  narsil_vector_file file = {NULL, 0, NULL};
  check(write_vector_file(fixture, path), "the test writes a vector file");
  check(narsil_vector_file_map(path, &file) == NARSIL_OK, "narsil_vector_file_map returns NARSIL_OK");
  check(file.length == UNALIGNED_PADDING_BYTES + ((uint64_t)NODES * VECTOR_BYTES), "the mapping spans the file");
  if (file.bytes != NULL) {
    score_from_a_file(workspace, fixture, &file);
    place_from_a_file(workspace, fixture);
  }
  narsil_vector_file_unmap(&file);
  check(file.bytes == NULL, "narsil_vector_file_unmap forgets the mapping");
  check(unlink(path) == 0, "the test deletes its vector file");
  check(narsil_vector_file_map(path, &file) == NARSIL_FILE_UNREADABLE,
        "narsil_vector_file_map returns NARSIL_FILE_UNREADABLE for a missing file");
  release_fixture(fixture);
}

#else

void vector_file_checks(narsil_workspace *workspace) { (void)workspace; }

#endif
