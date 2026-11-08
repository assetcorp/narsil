#include "fixture.h"

#include "../include/narsil_core.h"

#ifndef _WIN32

#include "../include/narsil_paged.h"
#include "../include/narsil_paged_vectors.h"

#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

enum { VECTOR_COUNT = 3, VECTOR_DIMENSION = 2, GRAPH_WORDS = 9, GRAPH_NODE_BYTES = 12, UNCHANGED = 73 };

static int write_pages(char *path) {
  int descriptor = mkstemp(path);
  if (descriptor < 0) { return 0; }
  FILE *file = fdopen(descriptor, "wb");
  if (file == NULL) {
    (void)close(descriptor);
    return 0;
  }
  const float vectors[VECTOR_COUNT * VECTOR_DIMENSION] = {1, 0, 1, 0, 0, 1};
  const uint32_t neighbours[GRAPH_WORDS] = {2, 1, 2, 2, 0, 2, 2, 0, 1};
  int written = fwrite(vectors, 1, sizeof vectors, file) == sizeof vectors &&
                fwrite(neighbours, 1, sizeof neighbours, file) == sizeof neighbours;
  return fclose(file) == 0 && written;
}

void paged_vector_checks(narsil_workspace *workspace) {
  char path[] = "/tmp/narsil-paged-vectors-XXXXXX";
  if (!write_pages(path)) {
    check(0, "the paged vector fixture opens its file");
    return;
  }
  narsil_paged_file *handle = NULL;
  check(narsil_paged_file_open(path, &handle) == NARSIL_OK, "the paged core opens the vector file");
  if (handle == NULL) {
    (void)unlink(path);
    return;
  }
  const uint32_t vector_checksum = UINT32_C(0x528a517b);
  const uint32_t graph_checksum = UINT32_C(0x638bf2b8);
  narsil_paged_vector_file file = {0,
                                   VECTOR_COUNT,
                                   NULL,
                                   0,
                                   {handle, 0, (size_t)VECTOR_COUNT * VECTOR_DIMENSION * sizeof(float),
                                    NARSIL_PAGE_SLOT_BYTES, (const uint8_t *)&vector_checksum, sizeof vector_checksum},
                                   NULL};
  uint32_t offsets[] = {0, GRAPH_NODE_BYTES, 2 * GRAPH_NODE_BYTES, 3 * GRAPH_NODE_BYTES};
  const uint8_t levels[] = {1, 1, 1};
  narsil_paged_graph_part part = {0,
                                  VECTOR_COUNT,
                                  levels,
                                  VECTOR_COUNT,
                                  offsets,
                                  VECTOR_COUNT + 1,
                                  {handle, file.vectors.length, GRAPH_WORDS * sizeof(uint32_t), NARSIL_PAGE_SLOT_BYTES,
                                   (const uint8_t *)&graph_checksum, sizeof graph_checksum}};
  narsil_paged_vector_field field = {
      VECTOR_DIMENSION, NARSIL_METRIC_COSINE, VECTOR_COUNT, 0, 1, 0, 0, NULL, 0, &file, 1, &part, 1};
  const float query[] = {1, 0};
  int64_t spent = 0;
  uint32_t stop = 0;
  narsil_paged_vector_request request = {query,
                                         VECTOR_DIMENSION,
                                         1,
                                         VECTOR_COUNT,
                                         VECTOR_COUNT,
                                         0,
                                         -HUGE_VAL,
                                         NULL,
                                         0,
                                         NULL,
                                         0,
                                         {&spent, INT64_MAX, &stop, 0}};
  uint32_t ordinals[VECTOR_COUNT] = {0};
  double scores[VECTOR_COUNT] = {0};
  uint32_t count = 0;
  narsil_page_fault fault = {0};
  narsil_paged_vector_output output = {ordinals, VECTOR_COUNT, scores, VECTOR_COUNT};
  check(narsil_search_paged_vectors(workspace, NULL, &field, &request, &output, &count, &fault) == NARSIL_OK &&
            count == 2 && ordinals[0] == 0 && ordinals[1] == 1 && scores[0] == 1 && scores[1] == 1 &&
            spent == (int64_t)VECTOR_COUNT * VECTOR_DIMENSION * 2,
        "paged search retains cutoff ties and counts every examined neighbour");
  count = ordinals[0] = UNCHANGED;
  scores[0] = (double)UNCHANGED;
  output.score_capacity = 1;
  check(narsil_search_paged_vectors(workspace, NULL, &field, &request, &output, &count, &fault) == NARSIL_NEEDS_ROOM &&
            count == UNCHANGED && ordinals[0] == UNCHANGED && scores[0] == (double)UNCHANGED,
        "paged search preserves candidate outputs on a short region");
  output.score_capacity = VECTOR_COUNT;
  output.ordinals = offsets;
  check(narsil_search_paged_vectors(workspace, NULL, &field, &request, &output, &count, &fault) ==
                NARSIL_INVALID_ARGUMENT &&
            count == UNCHANGED && offsets[0] == 0 && scores[0] == (double)UNCHANGED,
        "paged search refuses output overlapping graph offsets");
  output.ordinals = ordinals;
  offsets[1] = sizeof(uint32_t);
  check(narsil_search_paged_vectors(workspace, NULL, &field, &request, &output, &count, &fault) ==
                NARSIL_PAGE_INVALID &&
            count == UNCHANGED && ordinals[0] == UNCHANGED && scores[0] == (double)UNCHANGED &&
            fault.file == narsil_paged_file_identity(handle) && fault.section == file.vectors.length,
        "a neighbour count beyond its node fails before candidate publication");
  narsil_paged_file_close(handle);
  check(unlink(path) == 0, "the paged vector fixture removes its file");
}

#else

void paged_vector_checks(narsil_workspace *workspace) { (void)workspace; }

#endif
